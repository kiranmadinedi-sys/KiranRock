'use client';

import { Suspense, useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getApiBaseUrl } from '../config';
import { clearAuthToken, setAuthToken } from '../utils/session';

type ViewMode = 'login' | 'signup' | 'verify';

function LoginPageContent() {
    const [viewMode, setViewMode] = useState<ViewMode>('login');
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');
    const [loading, setLoading] = useState(false);
    const router = useRouter();
    const searchParams = useSearchParams();

    useEffect(() => {
        const justLoggedOut = sessionStorage.getItem('justLoggedOut');
        if (justLoggedOut) {
            sessionStorage.removeItem('justLoggedOut');
            return;
        }
        const token = localStorage.getItem('token');
        if (token) {
            const apiUrl = getApiBaseUrl();
            fetch(`${apiUrl}/api/auth/verify`, {
                headers: { 'Authorization': `Bearer ${token}` }
            })
            .then(res => {
                if (res.ok) {
                    const redirect = searchParams.get('redirect') || '/dashboard';
                    window.location.replace(redirect);
                } else {
                    clearAuthToken();
                }
            })
            .catch(() => {
                clearAuthToken();
            });
        }
    }, [searchParams]);

    const [loginUsername, setLoginUsername] = useState('');
    const [loginPassword, setLoginPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);

    const [signupData, setSignupData] = useState({
        username: '', email: '', password: '', confirmPassword: '',
        firstName: '', lastName: '', phone: ''
    });

    const [otp, setOtp] = useState('');
    const [signupEmail, setSignupEmail] = useState('');

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setLoading(true);
        try {
            const apiUrl = getApiBaseUrl();
            const response = await fetch(`${apiUrl}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: loginUsername, password: loginPassword }),
            });
            if (response.ok) {
                const { token, user } = await response.json();
                setAuthToken(token);
                if (user) localStorage.setItem('user', JSON.stringify(user));
                const redirect = searchParams.get('redirect') || '/dashboard';
                window.location.href = redirect;
            } else {
                let message = 'Invalid credentials. Please try again.';
                try {
                    const ct = response.headers.get('content-type') || '';
                    if (ct.includes('application/json')) {
                        const data = await response.json();
                        message = data?.error || data?.message || message;
                    }
                } catch (_) {}
                if (response.status === 429) message = 'Too many login attempts. Please wait 15 minutes.';
                setError(message);
            }
        } catch {
            setError('Network error. Please check your connection.');
        } finally {
            setLoading(false);
        }
    };

    const handleSignup = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setSuccess('');
        setLoading(true);
        if (signupData.password !== signupData.confirmPassword) {
            setError('Passwords do not match');
            setLoading(false);
            return;
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(signupData.email)) {
            setError('Please enter a valid email address');
            setLoading(false);
            return;
        }
        try {
            const apiUrl = getApiBaseUrl();
            const response = await fetch(`${apiUrl}/api/auth/signup`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(signupData),
            });
            const data = await response.json();
            if (response.ok) {
                setSignupEmail(signupData.email);
                setSuccess('Verification code sent!');
                setTimeout(() => { setViewMode('verify'); setSuccess(''); }, 1500);
            } else {
                setError(data.error || 'Signup failed. Please try again.');
            }
        } catch {
            setError('Network error. Please try again.');
        } finally {
            setLoading(false);
        }
    };

    const handleVerifyOTP = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setLoading(true);
        try {
            const apiUrl = getApiBaseUrl();
            const response = await fetch(`${apiUrl}/api/auth/verify-signup`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: signupEmail, otp }),
            });
            const data = await response.json();
            if (response.ok) {
                setAuthToken(data.token);
                if (data.user) localStorage.setItem('user', JSON.stringify(data.user));
                setSuccess('Account verified! Redirecting...');
                setTimeout(() => router.push('/dashboard'), 1500);
            } else {
                setError(data.error || 'Invalid verification code');
            }
        } catch {
            setError('Network error. Please try again.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="login-bg min-h-screen flex items-center justify-center p-4">
            {/* Animated background orbs */}
            <div className="fixed inset-0 overflow-hidden pointer-events-none">
                <div className="absolute -top-40 -right-40 w-80 h-80 bg-blue-500 rounded-full opacity-10 blur-3xl animate-pulse" />
                <div className="absolute -bottom-40 -left-40 w-96 h-96 bg-indigo-600 rounded-full opacity-10 blur-3xl animate-pulse" style={{ animationDelay: '1s' }} />
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-64 bg-purple-500 rounded-full opacity-5 blur-3xl" />
            </div>

            <div className="w-full max-w-md relative z-10">
                {/* Logo / Branding */}
                <div className="text-center mb-8">
                    <div className="inline-flex items-center justify-center w-16 h-16 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-2xl shadow-lg shadow-blue-500/30 mb-4">
                        <svg className="w-9 h-9 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                        </svg>
                    </div>
                    <h1 className="text-3xl font-bold text-white mb-1">KiranRock Trading</h1>
                    <p className="text-slate-400 text-sm">AI-Powered Professional Trading Platform</p>
                </div>

                {/* Card */}
                <div className="login-card rounded-2xl p-6 sm:p-8">
                    {/* Tab Switcher */}
                    {viewMode !== 'verify' && (
                        <div className="flex mb-6 bg-slate-800/60 rounded-xl p-1 gap-1">
                            <button
                                type="button"
                                onClick={() => { setViewMode('login'); setError(''); setSuccess(''); }}
                                className={`flex-1 py-2.5 px-4 rounded-lg text-sm font-semibold transition-all ${
                                    viewMode === 'login'
                                        ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/25'
                                        : 'text-slate-400 hover:text-white'
                                }`}
                            >
                                Sign In
                            </button>
                            <button
                                type="button"
                                onClick={() => { setViewMode('signup'); setError(''); setSuccess(''); }}
                                className={`flex-1 py-2.5 px-4 rounded-lg text-sm font-semibold transition-all ${
                                    viewMode === 'signup'
                                        ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/25'
                                        : 'text-slate-400 hover:text-white'
                                }`}
                            >
                                Create Account
                            </button>
                        </div>
                    )}

                    {/* Messages */}
                    {error && (
                        <div className="mb-5 flex items-start gap-3 px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-xl">
                            <svg className="w-5 h-5 text-red-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                            <span className="text-red-300 text-sm">{error}</span>
                        </div>
                    )}
                    {success && (
                        <div className="mb-5 flex items-start gap-3 px-4 py-3 bg-green-500/10 border border-green-500/20 rounded-xl">
                            <svg className="w-5 h-5 text-green-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                            <span className="text-green-300 text-sm">{success}</span>
                        </div>
                    )}

                    {/* Login Form */}
                    {viewMode === 'login' && (
                        <form onSubmit={handleLogin} className="space-y-5">
                            <div>
                                <label className="block text-sm font-medium text-slate-300 mb-2">Username</label>
                                <div className="relative">
                                    <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
                                        <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                                        </svg>
                                    </div>
                                    <input
                                        type="text"
                                        value={loginUsername}
                                        onChange={(e) => setLoginUsername(e.target.value)}
                                        placeholder="Enter your username"
                                        required
                                        autoComplete="username"
                                        className="input-pro pl-10"
                                    />
                                </div>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-300 mb-2">Password</label>
                                <div className="relative">
                                    <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
                                        <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                                        </svg>
                                    </div>
                                    <input
                                        type={showPassword ? 'text' : 'password'}
                                        value={loginPassword}
                                        onChange={(e) => setLoginPassword(e.target.value)}
                                        placeholder="Enter your password"
                                        required
                                        autoComplete="current-password"
                                        className="input-pro pl-10 pr-10"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => setShowPassword(!showPassword)}
                                        className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-slate-500 hover:text-slate-300 transition-colors"
                                    >
                                        {showPassword ? (
                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                                            </svg>
                                        ) : (
                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                            </svg>
                                        )}
                                    </button>
                                </div>
                            </div>
                            <button
                                type="submit"
                                disabled={loading}
                                className="btn-primary w-full py-3 text-base font-semibold mt-2 flex items-center justify-center gap-2"
                            >
                                {loading ? (
                                    <>
                                        <svg className="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
                                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                        </svg>
                                        Signing in...
                                    </>
                                ) : (
                                    <>
                                        Sign In
                                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                                        </svg>
                                    </>
                                )}
                            </button>
                        </form>
                    )}

                    {/* Signup Form */}
                    {viewMode === 'signup' && (
                        <form onSubmit={handleSignup} className="space-y-4">
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-xs font-medium text-slate-400 mb-1.5">First Name</label>
                                    <input
                                        type="text"
                                        value={signupData.firstName}
                                        onChange={(e) => setSignupData({ ...signupData, firstName: e.target.value })}
                                        placeholder="First"
                                        className="input-pro"
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-slate-400 mb-1.5">Last Name</label>
                                    <input
                                        type="text"
                                        value={signupData.lastName}
                                        onChange={(e) => setSignupData({ ...signupData, lastName: e.target.value })}
                                        placeholder="Last"
                                        className="input-pro"
                                    />
                                </div>
                            </div>
                            <div>
                                <label className="block text-xs font-medium text-slate-400 mb-1.5">Username <span className="text-blue-400">*</span></label>
                                <input
                                    type="text"
                                    value={signupData.username}
                                    onChange={(e) => setSignupData({ ...signupData, username: e.target.value })}
                                    placeholder="Choose a unique username"
                                    required
                                    className="input-pro"
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-medium text-slate-400 mb-1.5">Email <span className="text-blue-400">*</span></label>
                                <input
                                    type="email"
                                    value={signupData.email}
                                    onChange={(e) => setSignupData({ ...signupData, email: e.target.value })}
                                    placeholder="your.email@example.com"
                                    required
                                    className="input-pro"
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-medium text-slate-400 mb-1.5">Phone <span className="text-slate-600">(optional)</span></label>
                                <input
                                    type="tel"
                                    value={signupData.phone}
                                    onChange={(e) => setSignupData({ ...signupData, phone: e.target.value })}
                                    placeholder="+1 (555) 000-0000"
                                    className="input-pro"
                                />
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-xs font-medium text-slate-400 mb-1.5">Password <span className="text-blue-400">*</span></label>
                                    <input
                                        type="password"
                                        value={signupData.password}
                                        onChange={(e) => setSignupData({ ...signupData, password: e.target.value })}
                                        placeholder="Min 6 chars"
                                        required
                                        minLength={6}
                                        className="input-pro"
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-slate-400 mb-1.5">Confirm <span className="text-blue-400">*</span></label>
                                    <input
                                        type="password"
                                        value={signupData.confirmPassword}
                                        onChange={(e) => setSignupData({ ...signupData, confirmPassword: e.target.value })}
                                        placeholder="Repeat password"
                                        required
                                        minLength={6}
                                        className="input-pro"
                                    />
                                </div>
                            </div>
                            <button
                                type="submit"
                                disabled={loading}
                                className="btn-primary w-full py-3 text-base font-semibold mt-1 flex items-center justify-center gap-2"
                            >
                                {loading ? (
                                    <>
                                        <svg className="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
                                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                        </svg>
                                        Creating account...
                                    </>
                                ) : 'Create Account'}
                            </button>
                        </form>
                    )}

                    {/* OTP Verification */}
                    {viewMode === 'verify' && (
                        <div>
                            <button
                                onClick={() => { setViewMode('signup'); setOtp(''); setError(''); }}
                                className="mb-5 flex items-center gap-2 text-slate-400 hover:text-white text-sm transition-colors"
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                                </svg>
                                Back to Sign Up
                            </button>
                            <div className="text-center mb-6">
                                <div className="inline-flex items-center justify-center w-14 h-14 bg-blue-500/10 border border-blue-500/20 rounded-2xl mb-4">
                                    <svg className="w-7 h-7 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                                    </svg>
                                </div>
                                <h2 className="text-xl font-bold text-white mb-1">Check your email</h2>
                                <p className="text-sm text-slate-400">
                                    We sent a 6-digit code to<br />
                                    <span className="text-white font-medium">{signupEmail}</span>
                                </p>
                            </div>
                            <form onSubmit={handleVerifyOTP} className="space-y-5">
                                <div>
                                    <label className="block text-sm font-medium text-slate-300 mb-2 text-center">Verification Code</label>
                                    <input
                                        type="text"
                                        value={otp}
                                        onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                                        placeholder="000000"
                                        required
                                        maxLength={6}
                                        className="input-pro text-center text-3xl tracking-[0.5em] font-mono"
                                    />
                                    <p className="text-xs text-slate-500 text-center mt-2">Code expires in 10 minutes</p>
                                </div>
                                <button
                                    type="submit"
                                    disabled={loading || otp.length !== 6}
                                    className="btn-primary w-full py-3 text-base font-semibold flex items-center justify-center gap-2"
                                >
                                    {loading ? (
                                        <>
                                            <svg className="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
                                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                            </svg>
                                            Verifying...
                                        </>
                                    ) : 'Verify & Access Platform'}
                                </button>
                            </form>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <p className="text-center text-xs text-slate-600 mt-6">
                    Secured with JWT Authentication · Paper Trading Mode Active
                </p>
            </div>
        </div>
    );
}

export default function LoginPage() {
    return (
        <Suspense fallback={<div className="login-bg min-h-screen" />}>
            <LoginPageContent />
        </Suspense>
    );
}
