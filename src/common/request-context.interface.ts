export interface RequestContextStore {
  userId?: string;
  userEmail?: string;
  tenantId?: string;
  requestId?: string;
  causerType?: string;
  isFeedDisabled?: boolean;
}

export type UserExtractor = (req: any) => Partial<RequestContextStore>;

export interface RequestContextModuleOptions {
  userExtractor?: UserExtractor;
}
