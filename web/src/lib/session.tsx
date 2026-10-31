import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, onUnauthorized, tokens } from './api';

export type Role = 'admin' | 'accountant' | 'bookkeeper' | 'employee';

export interface User {
  id: string;
  name: string;
  email: string;
  locale?: string;
  timezone?: string;
  isPlatformAdmin?: boolean;
}

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  currency: string;
  industry?: string;
  plan: string;
  isSandbox?: boolean;
  settings?: Record<string, unknown>;
}

export interface Membership {
  tenant: Tenant;
  role: Role;
}

export interface Session {
  user: User;
  tenant: Tenant;
  role: Role;
  permissions: string[];
  flags: Record<string, boolean>;
  memberships: Membership[];
  twoFactorEnabled?: boolean;
}

interface LoginResponse {
  accessToken: string;
  refreshToken?: string;
  user?: User;
  tenant?: Tenant;
  role?: Role;
  requires2fa?: boolean;
}

interface SessionContextValue {
  session: Session | null;
  loading: boolean;
  login: (email: string, password: string, totp?: string) => Promise<{ requires2fa: boolean }>;
  loginDemo: () => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  switchTenant: (tenantId: string) => Promise<void>;
  can: (permission: string) => boolean;
  isRole: (...roles: Role[]) => boolean;
  featureEnabled: (flag: string) => boolean;
}

export interface RegisterInput {
  companyName: string;
  name: string;
  email: string;
  password: string;
  industry?: string;
  currency?: string;
  sampleData?: boolean;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  const loadMe = useCallback(async (): Promise<Session | null> => {
    if (!tokens.access) return null;
    try {
      const me = await api.get<Session>('/auth/me');
      setSession(me);
      return me;
    } catch {
      setSession(null);
      return null;
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await loadMe();
      setLoading(false);
    })();
  }, [loadMe]);

  useEffect(
    () =>
      onUnauthorized(() => {
        setSession(null);
      }),
    [],
  );

  const afterAuth = useCallback(
    async (result: LoginResponse) => {
      tokens.access = result.accessToken;
      if (result.refreshToken) localStorage.setItem('ledgerline.refreshToken', result.refreshToken);
      await loadMe();
    },
    [loadMe],
  );

  const login = useCallback(
    async (email: string, password: string, totp?: string) => {
      const result = await api.post<LoginResponse>('/auth/login', { email, password, totp: totp || undefined });
      if (result.requires2fa) return { requires2fa: true };
      await afterAuth(result);
      return { requires2fa: false };
    },
    [afterAuth],
  );

  const loginDemo = useCallback(async () => {
    const result = await api.post<LoginResponse>('/auth/demo', {});
    await afterAuth(result);
  }, [afterAuth]);

  const register = useCallback(
    async (input: RegisterInput) => {
      const result = await api.post<LoginResponse>('/auth/register', input);
      await afterAuth(result);
    },
    [afterAuth],
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout', {});
    } catch {
      /* the session is local anyway */
    }
    tokens.clear();
    localStorage.removeItem('ledgerline.refreshToken');
    setSession(null);
  }, []);

  const refresh = useCallback(async () => {
    await loadMe();
  }, [loadMe]);

  const switchTenant = useCallback(
    async (tenantId: string) => {
      const result = await api.post<LoginResponse>('/auth/switch-tenant', { tenantId });
      tokens.tenant = tenantId;
      await afterAuth(result);
    },
    [afterAuth],
  );

  const value = useMemo<SessionContextValue>(
    () => ({
      session,
      loading,
      login,
      loginDemo,
      register,
      logout,
      refresh,
      switchTenant,
      can: (permission) => Boolean(session?.permissions?.includes(permission)),
      isRole: (...roles) => Boolean(session && roles.includes(session.role)),
      featureEnabled: (flag) => Boolean(session?.flags?.[flag]),
    }),
    [session, loading, login, loginDemo, register, logout, refresh, switchTenant],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}
