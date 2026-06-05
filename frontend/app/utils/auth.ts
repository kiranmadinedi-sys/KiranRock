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
  localStorage.removeItem('user');
  localStorage.removeItem('lastActivity');
  document.cookie = 'token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
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