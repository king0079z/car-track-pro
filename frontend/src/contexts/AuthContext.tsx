import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { authApi } from '../services/api';
import { flushPendingClientErrors } from '../services/clientErrorReporter';
import type { User, AuthState } from '../types';

interface AuthContextType extends AuthState {
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  isLoading: boolean;
}

const TOKEN_KEY = 'cartrack_token';
const USER_KEY = 'cartrack_user';

const AuthContext = createContext<AuthContextType | null>(null);

function isTokenExpired(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.exp * 1000 < Date.now();
  } catch {
    return true;
  }
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const persistUser = useCallback((userData: User) => {
    localStorage.setItem(USER_KEY, JSON.stringify(userData));
    setUser(userData);
  }, []);

  // Restore session on mount and refresh permissions from /me
  useEffect(() => {
    const savedToken = localStorage.getItem(TOKEN_KEY);
    const savedUser = localStorage.getItem(USER_KEY);

    if (!savedToken || isTokenExpired(savedToken)) {
      if (savedToken) {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
      }
      setIsLoading(false);
      return;
    }

    setToken(savedToken);
    if (savedUser) {
      try {
        setUser(JSON.parse(savedUser));
      } catch {
        localStorage.removeItem(USER_KEY);
      }
    }

    authApi.me()
      .then(res => persistUser(res.data))
      .catch(() => {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
        setToken(null);
        setUser(null);
      })
      .finally(() => setIsLoading(false));
  }, [persistUser]);

  const login = useCallback(async (username: string, password: string) => {
    const res = await authApi.login(username, password);
    const { access_token, user: userData } = res.data;

    localStorage.setItem(TOKEN_KEY, access_token);
    persistUser(userData);
    setToken(access_token);
    void flushPendingClientErrors();
  }, [persistUser]);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    setToken(null);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{
      user, token,
      isAuthenticated: !!token && !!user,
      login, logout, isLoading,
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
};
