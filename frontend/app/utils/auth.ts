// Authentication utilities
export const getAuthToken = (): string | null => {
  return localStorage.getItem('token');
};

export const isAuthenticated = (): boolean => {
  const token = getAuthToken();
  return token !== null;
};

export const clearAuthToken = (): void => {
  localStorage.removeItem('token');
};

export const handleAuthError = (status: number): void => {
  if (status === 401) {
    console.error('Authentication failed - token may be expired');
    clearAuthToken();
    // Redirect to login if in browser environment
    if (typeof window !== 'undefined') {
      window.location.href = '/login';
    }
  }
};