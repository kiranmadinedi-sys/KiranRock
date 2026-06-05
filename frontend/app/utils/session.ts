/**
 * Session Management Utility
 * Handles authentication session with 30-minute timeout
 */

const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes in milliseconds
const LAST_ACTIVITY_KEY = 'lastActivity';

/**
 * Set authentication token and initialize session
 */
export function setAuthToken(token: string): void {
  // Set token in localStorage
  localStorage.setItem('token', token);
  
  // Set token in cookie for middleware access
  document.cookie = `token=${token}; path=/; max-age=${SESSION_TIMEOUT / 1000}; SameSite=Lax`;
  
  // Update last activity timestamp
  updateLastActivity();
}

/**
 * Get authentication token
 */
export function getAuthToken(): string | null {
  return localStorage.getItem('token');
}

/**
 * Remove authentication token and clear session
 */
export function clearAuthToken(): void {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  localStorage.removeItem(LAST_ACTIVITY_KEY);
  
  // Clear cookie
  document.cookie = 'token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
}

/**
 * Update last activity timestamp
 */
export function updateLastActivity(): void {
  localStorage.setItem(LAST_ACTIVITY_KEY, Date.now().toString());
}

/**
 * Check if session has timed out
 */
export function isSessionExpired(): boolean {
  const lastActivity = localStorage.getItem(LAST_ACTIVITY_KEY);
  
  if (!lastActivity) {
    return true;
  }
  
  const timeSinceLastActivity = Date.now() - parseInt(lastActivity, 10);
  return timeSinceLastActivity > SESSION_TIMEOUT;
}

/**
 * Check if user is authenticated
 */
export function isAuthenticated(): boolean {
  const token = getAuthToken();
  
  if (!token) {
    return false;
  }
  
  // Check if session has expired
  if (isSessionExpired()) {
    clearAuthToken();
    return false;
  }
  
  // Update activity on check
  updateLastActivity();
  return true;
}

/**
 * Initialize session timeout monitoring
 */
export function initializeSessionMonitoring(onTimeout: () => void): () => void {
  // Check session on page load
  if (!isAuthenticated()) {
    onTimeout();
    return;
  }
  
  // Monitor user activity
  const events = ['mousedown', 'keydown', 'scroll', 'touchstart', 'click'];
  
  const activityHandler = () => {
    if (isAuthenticated()) {
      updateLastActivity();
    }
  };
  
  events.forEach(event => {
    document.addEventListener(event, activityHandler, true);
  });
  
  // Check for timeout periodically
  const timeoutChecker = setInterval(() => {
    if (isSessionExpired()) {
      clearAuthToken();
      onTimeout();
    }
  }, 60000); // Check every minute
  
  // Cleanup function
  return () => {
    events.forEach(event => {
      document.removeEventListener(event, activityHandler, true);
    });
    clearInterval(timeoutChecker);
  };
}

/**
 * Extend session timeout (refresh the cookie)
 */
export function extendSession(): void {
  const token = getAuthToken();
  if (token) {
    document.cookie = `token=${token}; path=/; max-age=${SESSION_TIMEOUT / 1000}; SameSite=Lax`;
    updateLastActivity();
  }
}
