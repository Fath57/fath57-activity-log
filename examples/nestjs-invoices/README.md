# Example: invoices with a feed and an audit trail

A minimal but complete NestJS application wiring both modules, meant to be read
top to bottom and then run.

It deliberately shows the parts that are easy to get wrong rather than only the
happy path:

- the context is an **interceptor**, not a middleware, so `req.user` exists;
- a write goes through `em.transactional()`, so the audit row gets attribution;
- one endpoint uses `em.nativeUpdate()` to demonstrate the asymmetry — invisible
  to the feed, recorded by the trigger;
- the partition top-up cron is present, because without it every audit row ends
  up in the `DEFAULT` partition;
- the hardening script is printed at boot with a warning, because until a DBA
  runs it the audit trail is not yet tamper-resistant.

## Run it

```bash
npm run db:up                      # from the repository root
cd examples/nestjs-invoices
npm install
npm run migrate                    # creates the schema + tracks public.invoices
npm start
```

Then:

```bash
# create -> one feed entry, one audit row, both attributed to user-1
curl -X POST localhost:3000/invoices -H 'x-user-id: user-1' -H 'x-tenant-id: acme' \
     -H 'content-type: application/json' -d '{"reference":"INV-001","total":"100.00"}'

# read the feed for that invoice (scoped to the caller's tenant)
curl localhost:3000/invoices/<id>/activity -H 'x-user-id: user-1' -H 'x-tenant-id: acme'

# read the audit trail for the same row
curl localhost:3000/invoices/<id>/audit -H 'x-user-id: user-1'

# bulk discount via nativeUpdate: NO feed entry, but an audit row appears
curl -X POST localhost:3000/invoices/bulk-discount -H 'x-user-id: user-1' \
     -H 'content-type: application/json' -d '{"rate":0.1}'
```

Compare the two listings after the last call. That difference is the whole reason
the package ships two modules instead of one.
