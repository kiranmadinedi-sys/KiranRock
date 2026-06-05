'use client';

import { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { initializeSessionMonitoring, isAuthenticated } from '../utils/session';

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    // Don't check auth on login page
    if (pathname === '/login') {
      return;
    }

    // Check authentication on mount
    if (!isAuthenticated()) {
      router.push(`/login?redirect=${pathname}`);
      return;
    }

    // Initialize session monitoring
    const cleanup = initializeSessionMonitoring(() => {
      // Session expired - redirect to login
      alert('Your session has expired due to inactivity. Please login again.');
      router.push(`/login?redirect=${pathname}`);
    });

    return cleanup;
  }, [router, pathname]);

  return <>{children}</>;
}
