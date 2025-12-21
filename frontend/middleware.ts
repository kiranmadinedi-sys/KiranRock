import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  // Clone the request headers
  const requestHeaders = new Headers(request.headers);
  
  // Add origin header if missing (fixes Server Actions error)
  if (!requestHeaders.has('origin')) {
    const origin = request.headers.get('host') 
      ? `${request.nextUrl.protocol}//${request.headers.get('host')}`
      : request.nextUrl.origin;
    requestHeaders.set('origin', origin);
  }

  // Add x-forwarded-host if missing
  if (!requestHeaders.has('x-forwarded-host')) {
    requestHeaders.set('x-forwarded-host', request.headers.get('host') || '');
  }

  // Create response with modified headers
  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  // Add CORS headers for external access
  response.headers.set('Access-Control-Allow-Origin', '*');
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Origin');

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
