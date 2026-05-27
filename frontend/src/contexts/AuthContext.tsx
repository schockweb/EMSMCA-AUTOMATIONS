/**
 * Auth Context — manages user session state.
 */
import { createContext, useContext, useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import api from '../api/client';

interface User {
  id: string;
  email: string;
  full_name: string;
  role: string;
  bhf_practice_number?: string;
  is_active: boolean;
  permissions: string[];
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextType>({} as AuthContextType);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('access_token');
    if (token) {
      fetchUser();
    } else {
      setLoading(false);
    }
  }, []);

  const fetchUser = async () => {
    try {
      const res = await api.get('/api/auth/me');
      setUser(res.data);
    } catch (error: any) {
      if (error.response?.status === 401) {
        localStorage.removeItem('access_token');
        localStorage.removeItem('refresh_token');
      }
    } finally {
      setLoading(false);
    }
  };

  const login = async (email: string, password: string) => {
    const formData = new URLSearchParams();
    formData.append('username', email);
    formData.append('password', password);

    const res = await api.post('/api/auth/login', formData, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    localStorage.setItem('access_token', res.data.access_token);
    localStorage.setItem('refresh_token', res.data.refresh_token);
    await fetchUser();
  };

  const logout = async () => {
    // Server-side token revocation
    try {
      const refreshToken = localStorage.getItem('refresh_token');
      await api.post('/api/auth/logout', {
        refresh_token: refreshToken,
      });
    } catch {
      // Even if revocation fails, still clear local state
    }
    localStorage.removeItem('access_token');
    localStorage.removeItem('refresh_token');
    setUser(null);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        login,
        logout,
        isAuthenticated: !!user,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
