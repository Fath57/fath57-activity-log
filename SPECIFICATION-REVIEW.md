# Revue technique — `SPECIFICATION.md`

**Package** : `fath-activity-log` · **Round 4** — 2026-09-16
**État** : révision 4 de la spec (1091 lignes). **Tous les points ouverts des rounds 1–3 sont traités.**

Historique : v1 617 l. → v2 793 l. → v3 859 l. → **v4 1091 l.**

| Round | Points ouverts à l'entrée | Traités | Nouveaux défauts introduits |
| :--- | :---: | :---: | :---: |
| 1 → 2 | 49 | 43 | 4 |
| 2 → 3 | 26 | 8 | 4 |
| **3 → 4** | **26** | **26** | **0** |

---

## Traçabilité des corrections

### 🔴 Bloquants

| Réf. | Défaut | Correction appliquée | §  |
| :--- | :--- | :--- | :--- |
| **R3-1** | Contrôle du bypass **fail-open** : `NOT EXISTS(audit_admin) OR pg_has_role(...)` → bypass ouvert à tous sur une installation standard | Inversé en **fail-closed**. `pg_has_role(SESSION_USER, 'audit_bypass', 'MEMBER')` seul, avec `EXCEPTION WHEN undefined_object` qui **refuse** si le rôle est absent. Le rôle est créé vide par la migration pour que le test ait toujours une cible. | 5.3 |
| **R3-2** | `audit_admin` servait à la fois de propriétaire et de rôle de dérogation → accorder le bypass accordait la propriété de la table | Deux rôles disjoints : `audit_admin` (propriété, DBA) et `audit_bypass` (dérogation seule, aucun droit sur les tables). Tableau explicite. | 5.2 |
| **R3-3** | « Self-healing » : `DELETE`+`CREATE PARTITION`+`INSERT` sous `ACCESS EXCLUSIVE` → blocage proportionnel au volume | Séparé en deux opérations de profils de risque distincts. `create_monthly_partition()` **lève** au lieu de verrouiller si le DEFAULT est en conflit ; l'absorption devient un **runbook DBA** (`DETACH … CONCURRENTLY`, impossible en PL/pgSQL car hors bloc transactionnel). | 5.5 |
| **R3-4** | Plus aucune partition pré-créée, aucun cron → 100 % des lignes dans DEFAULT | `getInitialPartitionStatements(new Date(), 4)` restauré dans `up()`, **plus** le cron mensuel spécifié comme exigence opérationnelle avec son `@Cron`, et l'alerte sur `logged_actions_default` non vide. | 5.5, 8 |
| **R2-1** | `current_user_name DEFAULT CURRENT_USER` → toujours `audit_admin` sous `SECURITY DEFINER` | Colonne **supprimée**, avec la note expliquant pourquoi. `session_user_name` conservée (non affectée par `SECURITY DEFINER`). | 5.1 |
| **R2-3** | Map `exports` sans `require` vs test « dual CJS/ESM » de §10 | Tranché : **CJS uniquement**, justifié par le *dual package hazard* — `ActivityMetadataStorage` est un singleton de module, un double format produirait deux registres et des entités invisibles au subscriber. §10 aligné : `require()` + `import` via l'interop Node. | 2.1, 10 |
| **R2-4** | SQL RGPD : `WHERE row_id = :userId` sans `table_name`, sans bornes, non exécutable par `app_user` | Remplacé par `audit.anonymize_subject(...)`, une **PROCEDURE** : `p_table` obligatoire, bornes `p_from`/`p_to` pour l'élagage de partitions, lots avec `COMMIT`, boucle auto-terminante, `SECURITY DEFINER` possédée par `audit_admin`. `jsonb_exists_any` au lieu de `?|` (piège knex). | 7.2 |
| **R2-5** | `ActivityQueryService` sans filtre tenant → fuite inter-tenant | `FeedQueryOptions.tenantId` résolu depuis `RequestContextService` par défaut ; `null` = opt-out explicite back-office. Les trois index composites sont préfixés par `tenantId`. | 4.1, 4.7 |

### 🟠 Sérieux

| Réf. | Défaut | Correction appliquée | § |
| :--- | :--- | :--- | :--- |
| **R3-5** | Bornes de partition en `DATE` → conversion dépendante du `TimeZone` de session | `SET timezone = 'UTC'` sur la fonction + bornes calculées en `TIMESTAMPTZ` explicite via `AT TIME ZONE 'UTC'`. | 5.5 |
| **R3-6** | `track_table` et `create_monthly_partition` : `SECURITY DEFINER`, sans `OWNER TO` ni `REVOKE` | `REVOKE EXECUTE … FROM PUBLIC` sur les trois fonctions ; `ALTER … OWNER TO audit_admin` sur les trois plus la procédure, dans le script de hardening. Les partitions héritent dès lors d'`audit_admin`. | 5.3–5.5, 5.8 |
| **R3-7** | Table temporaire non qualifiée dans une fonction `SECURITY DEFINER` | Supprimée avec la logique de *healing* (**R3-3**). Le runbook n'utilise plus de table temporaire. | 5.5 |
| **R3-8** | `prune()` sans index : *seq scan* + suppression massive | Index `idx_activity_logs_created` ajouté ; `prune(olderThan, { batchSize })` supprime par lots avec commit intermédiaire ; partitionnement de `activity_logs` documenté au-delà de ~10⁸ lignes. | 4.1, 4.7 |
| **R2-7** | Régression : *lazy binding* remplacé par un `afterTransactionStart` inconditionnel | Rendu configurable — `sessionBinding: 'eager' \| 'lazy'`, défaut `'eager'`, avec le tableau des compromis (`'lazy'` perd l'attribution de `nativeUpdate`). Ligne restaurée en §6. | 5.6, 6 |
| **R2-8** | Sous PgBouncer, `session_user` et `client_addr` deviennent constants | `[!WARNING]` dédié en §1.1 ; cellule « User attribution forgery » réécrite ; conséquence sur `pg_has_role` (**R3-10**) énoncée au même endroit. | 1.1 |
| **R2-10** | ACL des partitions non couvertes par le `REVOKE` sur le parent | Boucle `DO $$` sur `pg_inherits` dans le script de hardening ; les partitions futures héritent d'`audit_admin` via la propriété de la fonction. Test dédié. | 5.8 |
| **R2-11** | §5.7 non exécutable par le rôle de migration | Script de hardening **sorti** de la migration, exporté via `getHardeningScript()`, avec un `[!IMPORTANT]` expliquant pourquoi le laisser dans `up()` garantit soit un échec, soit un rôle de migration sur-privilégié. | 5.8, 8 |
| **R2-12** | `REVOKE EXECUTE` manquant sur `track_table` | Ajouté, ainsi que sur `create_monthly_partition`. | 5.4, 5.5 |

### 🟡 Conception

| Réf. | Défaut | Correction appliquée | § |
| :--- | :--- | :--- | :--- |
| **R3-9** | Comportement des PK auto-générées indéfini | Tableau de comportement explicite + option `generatedIdStrategy: 'resolve' \| 'skip'`, et un `[!WARNING]` délimitant la frontière d'atomicité (`afterFlush` est post-commit hors `em.transactional()`). Test de rollback exigé. | 4.5 |
| **R3-10** | `pg_has_role(session_user, …)` tout-ou-rien sous PgBouncer | Documenté dans l'avertissement PgBouncer, avec la parade (un rôle de login par niveau de confiance). | 1.1 |
| **R3-11** | Deux encodages de `row_id` dans une même colonne | Colonne `row_id_is_json BOOLEAN` ajoutée ; encodage inscrit au contrat public ; `AuditQueryService.findForRow()` construit la forme composite pour l'appelant. | 5.1, 5.7 |
| **R2-13** | Fusion `LogOptions` × `ActivityOptionsConfig` inimplémentable | `getActivitylogOptions()` retourne un `Partial<>` ; `LogOptions.toPartial()` n'émet que les champs explicitement positionnés ; avertissement au bootstrap sur un objet totalement peuplé. | 4.2, 4.3 |
| **R2-15** | `outbox` n'existait que de nom | Spécifié : entité `ActivityOutbox`, drainer `FOR UPDATE SKIP LOCKED`, garantie **at-least-once** assumée, idempotence par `ON CONFLICT (id) DO NOTHING`, tests. | 4.8 |
| **R2-16** | Contextes non-HTTP sans solution | `RequestContextService.runWith()` exposé comme primitive ; l'interceptor en devient un simple wrapper. Section dédiée. | 2.3 |
| **R2-17** | `COALESCE(v_row_id, 'UNKNOWN')` masquait une `pk_column` erronée | Remplacé par un `RAISE EXCEPTION` (`undefined_column`), **et** validé en amont par `track_table` : colonnes inexistantes et recouvrement `pk_columns` ∩ `ignored_columns` rejetés à la configuration. | 5.3, 5.4 |
| **R2-19** | `activity_logs` sans rétention alors que §7 outillait l'audit | `prune()` + note explicite : c'est le magasin **le moins** protégé des deux (CRUD complet pour le rôle applicatif) et il contient des données personnelles. | 4.7, 7.1 |
| **R2-20** | `deletedAt` codé en dur | `softDeleteField?: string \| false`, global et surchargeable par entité. | 4.2, 4.4 |
| **R2-21** | « `DROP TABLE` zero-cost » | Réécrit : `ACCESS EXCLUSIVE` sur le parent, `DETACH … CONCURRENTLY` puis `DROP`. « Pas gratuit, mais borné ». | 6 |
| **R2-23** | Pagination par offset + `COUNT(*)` | Pagination par curseur (`CursorPage`, curseur opaque `(createdAt, id)`) ; comptage devenu opt-in via `countForSubject()`. | 4.7 |
| **R2-24** | `transaction_id BIGINT` + double transtypage | Type natif `XID8 NOT NULL DEFAULT pg_current_xact_id()`. | 5.1 |
| **R2-25** | `files` / `publishConfig` absents | Ajoutés au manifeste, avec `type: "commonjs"`. | 2.1 |
| **R1-16** | Description pré-rendue (ouvert depuis le round 1) | Section dédiée : `description` déclarée **fallback rendu**, `event` + `properties` désignés comme charge canonique, faiblesse héritée de spatie assumée. | 4.6 |

---

## Points additionnels traités au passage

Rencontrés en réécrivant, non signalés dans les rounds précédents :

- **`?` dans le SQL brut** — `jsonb_exists_any()` employé plutôt que l'opérateur `?|` dans la procédure RGPD, et la règle inscrite en note : aucun SQL livré par le package ne doit contenir `?`, `?|` ou `?&`, que knex interpréterait comme un placeholder.
- **Tentative de bypass tracée** — colonne `bypass_attempted`. Un `SET LOCAL audit.disabled` refusé n'est plus silencieux : il devient une preuve dans la ligne d'audit qu'il cherchait à empêcher.
- **Index sur la partition DEFAULT** — `idx_logged_actions_default_time`, sans lequel la sonde de conflit de `create_monthly_partition()` est un *seq scan* à chaque passage du cron.
- **Ordre du script de hardening** — la propriété des fonctions est transférée **avant** toute création de partition, sinon les partitions suivantes héritent du mauvais propriétaire.
- **`NamingStrategy`** — note explicite : le DDL livré correspond à la stratégie par défaut ; un hôte qui la change doit générer son schéma depuis les métadonnées.
- **`clock_timestamp()` ≠ ordre de commit** — note ajoutée, avec `transaction_id` comme clé de regroupement.
- **Note Vitest / `unplugin-swc`** — conservée et complétée : sans elle le build `tsc` passe pendant que les tests observent des métadonnées vides.

---

## Ce qui reste hors périmètre (assumé, pas oublié)

| Sujet | Décision |
| :--- | :--- |
| Falsification par un superuser / DBA | Déclaré hors périmètre en §1.1, avec la parade nommée : export vers un puits externe en append-only. |
| Attribution par utilisateur sous PgBouncer | Impossible au niveau moteur en pooling transactionnel. Documenté ; la parade est une connexion directe ou un rôle de login par niveau de confiance. |
| Garantie « sub-milliseconde » | Retirée définitivement. Remplacée par un bench qui **publie** des mesures par forme de ligne sans asserter de seuil. |
| Partitionnement de `activity_logs` | Non activé par défaut. Documenté comme recommandation au-delà de ~10⁸ lignes, avec les mêmes helpers. |
| Chiffrement au repos des payloads JSONB | Non traité — relève de la configuration PostgreSQL / du stockage, pas du package. |

---

## Vérifications à faire avant implémentation

La spec est cohérente, mais trois points relèvent de l'exécution et doivent être confirmés sur une base réelle avant de figer le code :

1. **`afterFlush` est-il émis avant ou après le commit** dans la version exacte de MikroORM v6 ciblée ? Toute la frontière d'atomicité de §4.5 en dépend. À vérifier par le test de rollback avant d'écrire le subscriber.
2. **Propagation de la propriété aux partitions** — confirmer qu'une partition créée depuis une fonction `SECURITY DEFINER` appartient bien au propriétaire de la fonction, et que `REVOKE` sur le parent ne couvre effectivement pas l'accès direct à l'enfant. C'est l'hypothèse sur laquelle repose tout §5.8.
3. **`DETACH PARTITION … CONCURRENTLY`** — vérifier le comportement exact sur la partition `DEFAULT` en PG 14/15/16, le runbook de §5.5 en dépend.

`partition-privileges.integration.spec.ts`, `partition-conflict.integration.spec.ts` et `auto-generated-pk.integration.spec.ts` sont précisément les tests qui transforment ces trois hypothèses en faits — à écrire en premier.

---

## Addendum — Révision 5 : coutures de portabilité

Ajout non issu d'une revue, mais d'une question d'architecture : *peut-on étendre à d'autres ORM et d'autres bases ?* La réponse structure une nouvelle **§11 — Portability & Platform Profiles**, et introduit les coutures correspondantes.

| Changement | § | Motif |
| :--- | :--- | :--- |
| Trois anneaux `core/` → `adapters/mikro-orm/` → `adapters/postgres/` | 9 | `core/` sans dépendance ORM ni driver, **vérifié en CI** par `dependency-cruiser` — une couture que rien ne défend se referme. |
| Quatre ports : `ChangeCapture`, `ActivityStore`, `ActivityReader`, `SessionBinder` | 11.1 | Seule surface dont dépend le noyau. `SessionBinder.scope` est dans le contrat : un adaptateur qui ne sait offrir qu'une portée `'session'` (MySQL) n'est pas un remplaçant transparent. |
| `registerActivity()` devient la primitive, `@LogsActivity` du sucre | 4.2 | Un décorateur de classe présuppose des entités-classes. Prisma et Drizzle n'en ont pas. Gratuit aujourd'hui, rupture après la v1. |
| `adapter:` explicite dans `FeedModule`/`AuditModule.forRoot()` | 2.2 | §2.2 est la **seule** surface visible du consommateur : c'est elle qui rend la couture chère après publication. |
| Sous-chemins `/mikro-orm` et `/postgres` ; peers `@mikro-orm/*` en `optional` | 2.1 | Un futur consommateur TypeORM ne doit pas installer MikroORM. Test de packaging : importer le paquet **sans** `@mikro-orm/*` doit réussir. |
| §1.1 et §5 renommées « profil PostgreSQL » / « implémentation de référence » | 1.1, 5 | Le threat model est une propriété de l'implémentation, pas du paquet. |
| `adapter-conformance.suite.ts` + `core-has-no-orm-dependency.spec.ts` | 10 | Critère d'acceptation d'un second adaptateur, et garde-fou de l'anneau central. |

**Trois arbitrages inscrits dans la spec :**

- **Prisma et Drizzle sont hors périmètre**, explicitement. Sans état antérieur bon marché, `logOnlyDirty`, `dontSubmitEmptyLogs` et le diff exact — ce qui distingue ce paquet d'un `logger.info()` — sont indisponibles ou coûtent une requête par mutation. `FeedModule.forRoot()` **refuse au démarrage** d'activer `logOnlyDirty` sur un adaptateur déclarant `providesBeforeState: false`, plutôt que de dégrader en silence. Cibles réalistes : TypeORM et Sequelize.
- **L'audit ne sera jamais abstrait.** Sa valeur *est* le triplet trigger + `SECURITY DEFINER` + `SET LOCAL`. Un second moteur livre sa propre §5, sa propre §7.2, ses propres migrations **et son propre tableau §1.1** — plusieurs lignes y deviennent « non atteignable » (SQLite : ni schémas ni rôles ; MongoDB : change streams post-commit, hors transaction).
- **Pas de découpage en paquets maintenant.** Les ports rendent la séparation mécanique le jour où un second adaptateur atterrit ; la faire avant serait payer un coût de publication pour un besoin hypothétique.

---

## Addendum — Révision 6 : ce que les tests d'intégration ont trouvé

115 tests, 19 fichiers, sur un PostgreSQL 16 dédié (`npm run db:up`). Les trois hypothèses signalées en fin de round 3 sont tranchées, et **cinq défauts ont été trouvés dans le code — aucun n'était détectable à la lecture.**

### Hypothèses vérifiées

| # | Hypothèse | Résultat |
| :--- | :--- | :--- |
| 1 | `afterFlush` avant ou après le commit ? | **Après.** Une connexion externe voit déjà la ligne quand le hook tourne. Mais dans `em.transactional()` le flush interne ne commite pas, donc l'`UPDATE` de résolution reste dans la transaction externe. §4.5 était exact **dans ses deux branches**. |
| 2 | Propriété des partitions + portée du `REVOKE` | **Confirmées.** Une partition créée depuis une fonction `SECURITY DEFINER` appartient au propriétaire de la fonction ; le `REVOKE` sur le parent ne couvre pas l'accès direct à l'enfant. §5.8 tient. |
| 3 | `DETACH … CONCURRENTLY` sur la DEFAULT | **Réfutée** → défaut #2. |

### Défauts trouvés et corrigés

| # | Défaut | Symptôme en production | Correction |
| :--- | :--- | :--- | :--- |
| 1 | `REVOKE ALL ON SCHEMA audit FROM PUBLIC` retirait `USAGE` à `audit_admin`, qui ne possédait pas le schéma | `permission denied for schema audit` à la première écriture après durcissement : **sécuriser l'audit l'éteignait** | `ALTER SCHEMA audit OWNER TO audit_admin` en tête de script |
| 2 | `DETACH PARTITION … CONCURRENTLY` est refusé dès qu'une partition DEFAULT existe | Runbook §5.5 inapplicable | `DETACH` simple, **la copie coûteuse se fait pendant que la DEFAULT est détachée** ; sonde de conflit rendue *attachment-aware* |
| 3 | Procédure RGPD à `COMMIT` interne, inappelable en protocole étendu | L'effacement, dont l'entrée est un identifiant personnel, aurait dû concaténer son SQL | Fonction par lot sans contrôle transactionnel + boucle côté paquet (`anonymizeSubject()`, paramètres liés) |
| 4 | `set_config` émis via `em.execute()`, qui prend sa propre connexion du pool | **`changed_by` NULL sur toutes les lignes, silencieusement** — le trigger tournait parfaitement et n'attribuait rien | Contexte de transaction passé explicitement à `getConnection().execute()` ; `catch {}` remplacé par un warning nommant la variable |
| 5 | Drainer outbox : `DELETE` et `INSERT` en autocommit séparés | Un échec en cours de lot vidait l'outbox **et** le feed — *at-most-once* là où §4.8 promet *at-least-once* | `fork.transactional()` autour du lot |

Le défaut #4 est le plus instructif : aucune erreur, aucun log, un audit qui tourne et ne sert à rien. La sonde l'a rendu visible d'un coup — relire le réglage *à l'intérieur même du hook qui venait de le poser* renvoyait `""`.

### Mesures publiées (§6)

`npm run bench` — PostgreSQL 16, médiane sur 60 UPDATE :

| Forme de ligne | médiane | vs base |
| :--- | ---: | ---: |
| ligne étroite, sans trigger | 0,97 ms | 1,0× |
| ligne étroite, auditée | 1,27 ms | 1,3× |
| 30 colonnes texte, auditée | 1,39 ms | 1,4× |
| colonne TOAST 512 Ko, **non** ignorée | 7,13 ms | **7,4×** |
| colonne TOAST 512 Ko, **ignorée** | 2,61 ms | 2,7× |

La largeur du tuple est quasi gratuite (1,3× → 1,4× sur 30 colonnes) ; c'est le dé-TOAST d'une seule grosse colonne qui domine tout le reste. La recommandation de §6 est désormais chiffrée, pas supposée.

### Reste ouvert

- Coutures de portabilité de la révision 5 : anneaux `core/` + `adapters/`, quatre ports, `registerActivity`, sous-chemins `/mikro-orm` et `/postgres`, peers optionnels. **Le code est toujours à la structure de la révision 4.**
- `logs-activity.decorator.spec.ts` (unitaire, listé en §10, absent).
- `core-has-no-orm-dependency.spec.ts` et `adapter-conformance.suite.ts` — dépendent des coutures.
- Aucun commit : le dépôt n'a pas d'historique.
