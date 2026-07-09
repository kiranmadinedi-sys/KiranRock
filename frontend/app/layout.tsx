import './globals.css';
import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { NotificationProvider } from './contexts/NotificationContext';
import { ThemeProvider } from './contexts/ThemeContext';
import AuthGuard from './components/AuthGuard';
import AppHeader from './components/AppHeader';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'AI Trading Pro - Professional Trading Platform',
  description: 'Professional AI-powered trading platform with real-time market analysis, paper trading, and advanced analytics',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'AI Trading Pro',
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0f172a' },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.className} antialiased`}>
        <ThemeProvider>
          <NotificationProvider>
            <AuthGuard>
              <AppHeader />
              {children}
              {/* Reserves space below page content so the fixed mobile bottom nav
                  (rendered inside AppHeader) doesn't cover the last bit of it. Was
                  previously placed inside AppHeader itself, which renders BEFORE
                  {children} here — landing the gap above every page's content
                  instead of below it (found 2026-07-09). */}
              <div className="lg:hidden h-16" />
            </AuthGuard>
          </NotificationProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
