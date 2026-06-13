'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Logo from '../components/Logo';
import ThemeToggle from '../components/ThemeToggle';
import { getApiBaseUrl } from '../config';

interface UserProfile {
    id: string;
    username: string;
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
    createdAt: string;
    aiTradingEnabled: boolean;
    tradingAccount: {
        balance: number;
        totalDeposited: number;
        totalWithdrawn: number;
    };
}

function formatCurrency(value?: number) {
    const numericValue = Number(value ?? 0);
    return numericValue.toLocaleString(undefined, {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

export default function ProfilePage() {
    const [token, setToken] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [profile, setProfile] = useState<UserProfile | null>(null);
    const [firstName, setFirstName] = useState('');
    const [lastName, setLastName] = useState('');
    const [email, setEmail] = useState('');
    const [phone, setPhone] = useState('');
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [passwordMessage, setPasswordMessage] = useState('');
    const [passwordError, setPasswordError] = useState('');
    const [aiTradingEnabled, setAiTradingEnabled] = useState(false);
    const [aiTradingLoading, setAiTradingLoading] = useState(false);
    const [activeSection, setActiveSection] = useState<'profile' | 'password' | 'account' | 'ai' | 'broker'>('profile');

    // Broker settings state
    interface BrokerStatus { configured: boolean; source: 'user' | 'env'; keyId: string | null; isPaper: boolean; }
    const [brokerStatus, setBrokerStatus] = useState<BrokerStatus | null>(null);
    const [brokerKeyId, setBrokerKeyId] = useState('');
    const [brokerSecretKey, setBrokerSecretKey] = useState('');
    const [brokerIsPaper, setBrokerIsPaper] = useState(true);
    const [brokerSaving, setBrokerSaving] = useState(false);
    const [brokerMsg, setBrokerMsg] = useState<{ ok: boolean; text: string } | null>(null);

    useEffect(() => {
        const storedToken = localStorage.getItem('token');
        if (!storedToken) {
            window.location.href = '/login';
            return;
        }

        setToken(storedToken);
    }, []);

    useEffect(() => {
        if (!token) {
            return;
        }

        fetchProfile();
        fetchBrokerStatus(token);
    }, [token]);

    const fetchProfile = async () => {
        setLoading(true);
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/profile`, {
                headers: { Authorization: `Bearer ${token}` }
            });

            if (response.ok) {
                const data = await response.json();
                setProfile(data);
                setFirstName(data.firstName || '');
                setLastName(data.lastName || '');
                setEmail(data.email || '');
                setPhone(data.phone || '');
                setAiTradingEnabled(data.aiTradingEnabled || false);
            }
        } catch (error) {
            console.error('Failed to fetch profile:', error);
        } finally {
            setLoading(false);
            setAiTradingLoading(false);
        }
    };

    const handleUpdateProfile = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/profile`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`
                },
                body: JSON.stringify({ firstName, lastName, email, phone })
            });

            if (response.ok) {
                const data = await response.json();
                setProfile(data);
                alert('Profile updated successfully.');
            } else {
                const error = await response.json();
                alert(`Error: ${error.error}`);
            }
        } catch (error) {
            console.error('Failed to update profile:', error);
            alert('Failed to update profile.');
        } finally {
            setSaving(false);
        }
    };

    const handleChangePassword = async (e: React.FormEvent) => {
        e.preventDefault();
        setPasswordMessage('');
        setPasswordError('');

        if (newPassword !== confirmPassword) {
            setPasswordError('New passwords do not match');
            return;
        }

        if (newPassword.length < 6) {
            setPasswordError('Password must be at least 6 characters');
            return;
        }

        setSaving(true);
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/profile/change-password`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`
                },
                body: JSON.stringify({ currentPassword, newPassword })
            });

            const data = await response.json();
            if (response.ok) {
                setPasswordMessage('Password changed successfully.');
                setCurrentPassword('');
                setNewPassword('');
                setConfirmPassword('');
            } else {
                setPasswordError(data.error || 'Failed to change password');
            }
        } catch (error) {
            console.error('Failed to change password:', error);
            setPasswordError('Failed to change password');
        } finally {
            setSaving(false);
        }
    };

    const handleToggleAITrading = async () => {
        if (aiTradingLoading) {
            return;
        }

        setAiTradingLoading(true);
        const timeoutId = setTimeout(() => {
            setAiTradingLoading(false);
            alert('Request timed out. Please try again.');
        }, 10000);

        try {
            const response = await fetch(`${getApiBaseUrl()}/api/profile/ai-trading/toggle`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`
                },
                body: JSON.stringify({ enabled: !aiTradingEnabled })
            });

            const data = await response.json();
            clearTimeout(timeoutId);

            if (response.ok) {
                setAiTradingEnabled(!aiTradingEnabled);
                alert(data.message || 'AI Trading updated successfully.');
            } else {
                alert(`Error: ${data.error || 'Unknown error occurred'}`);
            }
        } catch (error) {
            clearTimeout(timeoutId);
            console.error('Failed to toggle AI trading:', error);
            alert('Failed to toggle AI trading.');
        } finally {
            setAiTradingLoading(false);
        }
    };

    const fetchBrokerStatus = async (tok: string) => {
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/profile/broker`, {
                headers: { Authorization: `Bearer ${tok}` }
            });
            if (res.ok) {
                const data = await res.json();
                setBrokerStatus(data);
                setBrokerIsPaper(data.isPaper !== false);
                if (data.configured && data.keyId) setBrokerKeyId(data.keyId); // pre-fill only user's own key
            }
        } catch (_) {}
    };

    const handleSaveBroker = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!brokerKeyId.trim()) { setBrokerMsg({ ok: false, text: 'Alpaca Key ID is required.' }); return; }
        setBrokerSaving(true);
        setBrokerMsg(null);
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/profile/broker`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ keyId: brokerKeyId.trim(), secretKey: brokerSecretKey || undefined, isPaper: brokerIsPaper })
            });
            const data = await res.json();
            if (res.ok) {
                setBrokerMsg({ ok: data.ok, text: data.message });
                await fetchBrokerStatus(token!);
                setBrokerSecretKey(''); // clear secret from form after save
            } else {
                setBrokerMsg({ ok: false, text: data.error || 'Save failed.' });
            }
        } catch (_) {
            setBrokerMsg({ ok: false, text: 'Network error.' });
        } finally {
            setBrokerSaving(false);
        }
    };

    const handleClearBroker = async () => {
        if (!confirm('Remove your personal Alpaca credentials and revert to the shared paper account?')) return;
        setBrokerSaving(true);
        setBrokerMsg(null);
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/profile/broker`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` }
            });
            const data = await res.json();
            if (res.ok) {
                setBrokerMsg({ ok: true, text: data.message });
                setBrokerKeyId('');
                await fetchBrokerStatus(token!);
            } else {
                setBrokerMsg({ ok: false, text: data.error || 'Clear failed.' });
            }
        } catch (_) {
            setBrokerMsg({ ok: false, text: 'Network error.' });
        } finally {
            setBrokerSaving(false);
        }
    };

    const handleLogout = () => {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        document.cookie = 'token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
        sessionStorage.setItem('justLoggedOut', 'true');
        window.location.replace('/login');
    };

    if (!token || loading) {
        return (
            <div className="min-h-screen bg-[var(--color-bg-primary)] flex items-center justify-center">
                <div className="text-[var(--color-text-primary)]">Loading profile...</div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-[var(--color-bg-primary)]">
            <header className="bg-[var(--color-card)] border-b border-[var(--color-border)] shadow-sm sticky top-0 z-50">
                <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-6">
                        <Link href="/dashboard">
                            <Logo />
                        </Link>
                        <nav className="hidden md:flex items-center gap-2 text-sm font-semibold">
                            <Link href="/dashboard" className="py-2 px-4 rounded-lg text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] transition-colors">Dashboard</Link>
                            <Link href="/portfolio" className="py-2 px-4 rounded-lg text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] transition-colors">Portfolio</Link>
                            <Link href="/ai-trading" className="py-2 px-4 rounded-lg text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] transition-colors">AI Trading</Link>
                        </nav>
                    </div>

                    <div className="flex items-center gap-3">
                        <ThemeToggle />
                        <button
                            onClick={handleLogout}
                            className="px-4 py-2 rounded-lg bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] font-semibold hover:bg-[var(--color-bg-secondary)] transition-colors border border-[var(--color-border)]"
                        >
                            Logout
                        </button>
                    </div>
                </div>
            </header>

            <main className="max-w-7xl mx-auto px-4 py-8 grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-6">
                <aside className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-2xl p-4 h-fit">
                    <h2 className="text-sm uppercase tracking-[0.2em] text-[var(--color-text-secondary)] mb-4">Settings</h2>
                    <div className="space-y-2">
                        <button onClick={() => setActiveSection('profile')} className={`w-full text-left px-4 py-3 rounded-xl font-semibold transition-colors ${activeSection === 'profile' ? 'bg-[var(--color-accent)] text-white' : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)]'}`}>Profile</button>
                        <button onClick={() => setActiveSection('password')} className={`w-full text-left px-4 py-3 rounded-xl font-semibold transition-colors ${activeSection === 'password' ? 'bg-[var(--color-accent)] text-white' : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)]'}`}>Password</button>
                        <button onClick={() => setActiveSection('account')} className={`w-full text-left px-4 py-3 rounded-xl font-semibold transition-colors ${activeSection === 'account' ? 'bg-[var(--color-accent)] text-white' : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)]'}`}>Trading Account</button>
                        <button onClick={() => setActiveSection('ai')} className={`w-full text-left px-4 py-3 rounded-xl font-semibold transition-colors ${activeSection === 'ai' ? 'bg-[var(--color-accent)] text-white' : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)]'}`}>AI Automation</button>
                        <button onClick={() => setActiveSection('broker')} className={`w-full text-left px-4 py-3 rounded-xl font-semibold transition-colors ${activeSection === 'broker' ? 'bg-[var(--color-accent)] text-white' : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)]'}`}>Broker Settings</button>
                    </div>
                </aside>

                <div className="space-y-6">
                    {activeSection === 'profile' && (
                        <div className="bg-[var(--color-card)] rounded-2xl border border-[var(--color-border)] p-6">
                            <h1 className="text-2xl font-bold text-[var(--color-text-primary)] mb-2">Profile</h1>
                            <p className="text-sm text-[var(--color-text-secondary)] mb-6">Manage your account details and contact information.</p>

                            <form onSubmit={handleUpdateProfile} className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-2">Username</label>
                                    <input value={profile?.username || ''} disabled className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]" />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-2">Member Since</label>
                                    <input value={profile?.createdAt ? new Date(profile.createdAt).toLocaleDateString() : ''} disabled className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]" />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-2">First Name</label>
                                    <input value={firstName} onChange={(e) => setFirstName(e.target.value)} className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-primary)]" />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-2">Last Name</label>
                                    <input value={lastName} onChange={(e) => setLastName(e.target.value)} className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-primary)]" />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-2">Email</label>
                                    <input value={email} onChange={(e) => setEmail(e.target.value)} className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-primary)]" />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-2">Phone</label>
                                    <input value={phone} onChange={(e) => setPhone(e.target.value)} className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-primary)]" />
                                </div>
                                <div className="md:col-span-2 pt-2">
                                    <button type="submit" disabled={saving} className="px-6 py-3 rounded-xl bg-[var(--color-accent)] text-white font-semibold hover:opacity-90 transition-opacity disabled:opacity-50">
                                        {saving ? 'Saving...' : 'Save Profile'}
                                    </button>
                                </div>
                            </form>
                        </div>
                    )}

                    {activeSection === 'password' && (
                        <div className="bg-[var(--color-card)] rounded-2xl border border-[var(--color-border)] p-6">
                            <h1 className="text-2xl font-bold text-[var(--color-text-primary)] mb-2">Password</h1>
                            <p className="text-sm text-[var(--color-text-secondary)] mb-6">Change your account password.</p>

                            <form onSubmit={handleChangePassword} className="space-y-4 max-w-xl">
                                <div>
                                    <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-2">Current Password</label>
                                    <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-primary)]" />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-2">New Password</label>
                                    <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-primary)]" />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-2">Confirm New Password</label>
                                    <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-primary)]" />
                                </div>
                                {passwordMessage && <div className="rounded-xl bg-green-500/10 border border-green-500 px-4 py-3 text-sm text-green-600">{passwordMessage}</div>}
                                {passwordError && <div className="rounded-xl bg-red-500/10 border border-red-500 px-4 py-3 text-sm text-red-600">{passwordError}</div>}
                                <button type="submit" disabled={saving} className="px-6 py-3 rounded-xl bg-[var(--color-accent)] text-white font-semibold hover:opacity-90 transition-opacity disabled:opacity-50">
                                    {saving ? 'Updating...' : 'Change Password'}
                                </button>
                            </form>
                        </div>
                    )}

                    {activeSection === 'account' && (
                        <div className="bg-[var(--color-card)] rounded-2xl border border-[var(--color-border)] p-6">
                            <h1 className="text-2xl font-bold text-[var(--color-text-primary)] mb-2">Trading Account</h1>
                            <p className="text-sm text-[var(--color-text-secondary)] mb-6">Overview of your paper-trading account.</p>

                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                                <div className="bg-[var(--color-bg-tertiary)] p-5 rounded-xl">
                                    <div className="text-sm text-[var(--color-text-secondary)] mb-1">Current Balance</div>
                                    <div className="text-2xl font-bold text-[var(--color-text-primary)]">{formatCurrency(profile?.tradingAccount?.balance)}</div>
                                </div>
                                <div className="bg-[var(--color-bg-tertiary)] p-5 rounded-xl">
                                    <div className="text-sm text-[var(--color-text-secondary)] mb-1">Total Deposited</div>
                                    <div className="text-2xl font-bold text-green-500">{formatCurrency(profile?.tradingAccount?.totalDeposited)}</div>
                                </div>
                                <div className="bg-[var(--color-bg-tertiary)] p-5 rounded-xl">
                                    <div className="text-sm text-[var(--color-text-secondary)] mb-1">Total Withdrawn</div>
                                    <div className="text-2xl font-bold text-red-500">{formatCurrency(profile?.tradingAccount?.totalWithdrawn)}</div>
                                </div>
                            </div>

                            <div className="bg-blue-500/10 border border-blue-500 rounded-xl p-5 mb-6">
                                <h3 className="font-semibold text-blue-500 mb-2">Paper Trading Environment</h3>
                                <p className="text-sm text-[var(--color-text-secondary)]">
                                    This account uses virtual funds for strategy testing. Visit the <Link href="/portfolio" className="text-[var(--color-accent)] hover:underline">Portfolio page</Link> to deposit, trade manually, and review performance.
                                </p>
                            </div>

                            <div className="flex gap-4 flex-wrap">
                                <Link href="/portfolio" className="bg-[var(--color-accent)] text-white px-6 py-3 rounded-lg font-semibold hover:opacity-90 transition-opacity">View Portfolio</Link>
                                <Link href="/portfolio" className="bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] px-6 py-3 rounded-lg font-semibold hover:bg-[var(--color-bg-secondary)] transition-colors border border-[var(--color-border)]">Deposit Funds</Link>
                            </div>
                        </div>
                    )}

                    {activeSection === 'ai' && (
                        <div className="bg-[var(--color-card)] rounded-2xl border border-[var(--color-border)] p-6">
                            <h1 className="text-2xl font-bold text-[var(--color-text-primary)] mb-2">AI Trading Automation</h1>
                            <p className="text-sm text-[var(--color-text-secondary)] mb-6">A consolidated view of what the AI layer can actually do today.</p>

                            <div className="bg-blue-500/10 border border-blue-500 rounded-xl p-6 mb-6">
                                <h3 className="text-lg font-semibold text-blue-500 mb-3">Feature-Complete Automation Layer</h3>
                                <p className="text-sm text-[var(--color-text-secondary)] mb-4">
                                    The system includes legacy manual AI portfolio controls plus worker-driven enhanced automation. When AI trading is enabled, the platform can initialize positions, rebalance, execute both buys and sells, enforce risk rules, and record decisions.
                                </p>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm text-[var(--color-text-secondary)]">
                                    <div>✅ <strong>Automated Buy/Sell:</strong> Entry and exit order paths are available.</div>
                                    <div>✅ <strong>Trailing Stop:</strong> Enhanced automation can trail from peak price.</div>
                                    <div>✅ <strong>Partial Take-Profit:</strong> Winners can be trimmed before full exits.</div>
                                    <div>✅ <strong>5-Minute Monitoring:</strong> Worker checks the market every 5 minutes.</div>
                                    <div>✅ <strong>Risk Guards:</strong> Emergency stop and kill-switch support exist.</div>
                                    <div>✅ <strong>Decision Visibility:</strong> Use the dashboard to inspect status and activity.</div>
                                </div>
                            </div>

                            <div className="bg-[var(--color-bg-tertiary)] rounded-xl p-6 mb-6">
                                <div className="flex items-center justify-between gap-4">
                                    <div className="flex-1">
                                        <h3 className="text-lg font-semibold text-[var(--color-text-primary)] mb-2">
                                            {aiTradingEnabled ? '✅ AI Trading is Active' : '⏸️ AI Trading is Disabled'}
                                        </h3>
                                        <p className="text-sm text-[var(--color-text-secondary)]">
                                            {aiTradingEnabled
                                                ? 'Automation is enabled for your account. The worker can monitor market state, execute buys and sells, and apply stop-loss, trailing-stop, and take-profit logic.'
                                                : 'Enable AI Trading to let the automated engine manage your paper-trading portfolio during market hours.'}
                                        </p>
                                    </div>
                                    <button
                                        onClick={handleToggleAITrading}
                                        disabled={aiTradingLoading}
                                        className={`relative inline-flex h-12 w-24 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 ${
                                            aiTradingEnabled
                                                ? 'bg-green-600 focus:ring-green-500'
                                                : 'bg-gray-300 dark:bg-gray-600 focus:ring-gray-400'
                                        } ${aiTradingLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
                                    >
                                        <span className={`inline-block h-10 w-10 transform rounded-full bg-white shadow-lg transition-transform ${aiTradingEnabled ? 'translate-x-12' : 'translate-x-1'}`} />
                                        <span className={`absolute text-xs font-bold ${aiTradingEnabled ? 'left-2 text-white' : 'right-2 text-gray-700 dark:text-gray-300'}`}>
                                            {aiTradingEnabled ? 'ON' : 'OFF'}
                                        </span>
                                    </button>
                                </div>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                                <div className="bg-[var(--color-bg-tertiary)] p-5 rounded-xl">
                                    <h4 className="font-semibold text-[var(--color-text-primary)] mb-3">Execution Flow</h4>
                                    <ul className="space-y-2 text-sm text-[var(--color-text-secondary)]">
                                        <li>• Auto-initializes empty portfolios</li>
                                        <li>• Rebalances based on AI score and position drift</li>
                                        <li>• Supports both BUY and SELL execution paths</li>
                                        <li>• Records recent actions for review</li>
                                    </ul>
                                </div>
                                <div className="bg-[var(--color-bg-tertiary)] p-5 rounded-xl">
                                    <h4 className="font-semibold text-[var(--color-text-primary)] mb-3">Risk Stack</h4>
                                    <ul className="space-y-2 text-sm text-[var(--color-text-secondary)]">
                                        <li>• Stop-loss rules on losing positions</li>
                                        <li>• Trailing-stop protection from peak price</li>
                                        <li>• Partial and full take-profit logic</li>
                                        <li>• Market-hour checks and emergency controls</li>
                                    </ul>
                                </div>
                            </div>

                            <div className={`rounded-xl p-5 border ${aiTradingEnabled ? 'bg-yellow-500/10 border-yellow-500' : 'bg-green-500/10 border-green-500'} mb-6`}>
                                <h4 className={`font-semibold mb-2 ${aiTradingEnabled ? 'text-yellow-500' : 'text-green-500'}`}>
                                    {aiTradingEnabled ? 'Automation Running' : 'Ready to Enable'}
                                </h4>
                                <p className="text-sm text-[var(--color-text-secondary)]">
                                    {aiTradingEnabled
                                        ? 'Use the AI Trading dashboard to inspect scheduler state, market-open status, trailing-stop coverage, last activity, and current risk controls.'
                                        : 'Once enabled, the AI can begin managing your portfolio automatically. The dashboard shows the live feature surface and operational state.'}
                                </p>
                            </div>

                            <Link href="/ai-trading" className="inline-block bg-[var(--color-accent)] text-white px-6 py-3 rounded-lg font-semibold hover:opacity-90 transition-opacity">
                                Open AI Trading Dashboard →
                            </Link>
                        </div>
                    )}
                    {activeSection === 'broker' && (
                        <div className="bg-[var(--color-card)] rounded-2xl border border-[var(--color-border)] p-6">
                            <h1 className="text-2xl font-bold text-[var(--color-text-primary)] mb-2">Broker Settings</h1>
                            <p className="text-sm text-[var(--color-text-secondary)] mb-6">
                                Store your personal Alpaca credentials here. In paper-trading mode all users share a single practice account — your keys will be used when you are ready to switch to live trading.
                            </p>

                            {/* Current status banner */}
                            <div className={`rounded-xl px-5 py-4 border mb-6 ${brokerStatus?.configured ? 'bg-green-500/10 border-green-500' : 'bg-blue-500/10 border-blue-500'}`}>
                                <div className="flex items-center gap-3">
                                    <span className="text-xl">{brokerStatus?.configured ? '🔑' : '🔗'}</span>
                                    <div>
                                        <div className={`font-semibold ${brokerStatus?.configured ? 'text-green-500' : 'text-blue-500'}`}>
                                            {brokerStatus?.configured
                                                ? `Using your personal Alpaca account (${brokerStatus.isPaper ? 'Paper' : 'Live'})`
                                                : 'Using shared paper-trading account (all users)'}
                                        </div>
                                        {brokerStatus?.configured && brokerStatus.keyId && (
                                            <div className="text-xs text-[var(--color-text-secondary)] mt-0.5">Key: {brokerStatus.keyId}</div>
                                        )}
                                        {!brokerStatus?.configured && (
                                            <div className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                                                Add your Alpaca API keys below to link your personal account for live trading.
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>

                            {/* Info callout */}
                            <div className="bg-yellow-500/10 border border-yellow-500 rounded-xl px-5 py-4 mb-6 text-sm text-[var(--color-text-secondary)]">
                                <span className="font-semibold text-yellow-500">How to get your Alpaca API keys:</span>
                                {' '}Log in to alpaca.markets → Your account → API Keys → Generate New Key. Copy both the <em>Key ID</em> and the <em>Secret Key</em> — the secret is shown only once.
                            </div>

                            {/* Credential form */}
                            <form onSubmit={handleSaveBroker} className="space-y-4 max-w-xl">
                                <div>
                                    <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-2">Alpaca Key ID</label>
                                    <input
                                        value={brokerKeyId}
                                        onChange={e => setBrokerKeyId(e.target.value)}
                                        placeholder="e.g. PKXXXXXXXXXXXXXXXX"
                                        autoComplete="off"
                                        className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] font-mono text-sm"
                                    />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-2">
                                        Secret Key <span className="text-[var(--color-text-secondary)] font-normal">(leave blank to keep existing)</span>
                                    </label>
                                    <input
                                        type="password"
                                        value={brokerSecretKey}
                                        onChange={e => setBrokerSecretKey(e.target.value)}
                                        placeholder="Paste your secret key here"
                                        autoComplete="new-password"
                                        className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] font-mono text-sm"
                                    />
                                    <p className="text-xs text-[var(--color-text-secondary)] mt-1">Stored encrypted. Never displayed again after saving.</p>
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-3">Account Type</label>
                                    <div className="flex gap-3">
                                        <button
                                            type="button"
                                            onClick={() => setBrokerIsPaper(true)}
                                            className={`px-5 py-2.5 rounded-xl font-semibold text-sm transition-colors border ${brokerIsPaper ? 'bg-blue-500 text-white border-blue-500' : 'border-[var(--color-border)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)]'}`}
                                        >
                                            Paper Trading
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setBrokerIsPaper(false)}
                                            className={`px-5 py-2.5 rounded-xl font-semibold text-sm transition-colors border ${!brokerIsPaper ? 'bg-orange-500 text-white border-orange-500' : 'border-[var(--color-border)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)]'}`}
                                        >
                                            Live Trading
                                        </button>
                                    </div>
                                    {!brokerIsPaper && (
                                        <div className="mt-3 rounded-xl bg-red-500/10 border border-red-500 px-4 py-3 text-sm text-red-500 font-semibold">
                                            Live trading uses real money. Make sure you have completed paper-trading validation before switching.
                                        </div>
                                    )}
                                </div>

                                {brokerMsg && (
                                    <div className={`rounded-xl px-4 py-3 text-sm border ${brokerMsg.ok ? 'bg-green-500/10 border-green-500 text-green-600' : 'bg-red-500/10 border-red-500 text-red-600'}`}>
                                        {brokerMsg.text}
                                    </div>
                                )}

                                <div className="flex gap-3 pt-1">
                                    <button
                                        type="submit"
                                        disabled={brokerSaving}
                                        className="px-6 py-3 rounded-xl bg-[var(--color-accent)] text-white font-semibold hover:opacity-90 transition-opacity disabled:opacity-50"
                                    >
                                        {brokerSaving ? 'Saving...' : 'Save & Test Connection'}
                                    </button>
                                    {brokerStatus?.configured && (
                                        <button
                                            type="button"
                                            onClick={handleClearBroker}
                                            disabled={brokerSaving}
                                            className="px-6 py-3 rounded-xl border border-[var(--color-border)] text-[var(--color-text-secondary)] font-semibold hover:bg-[var(--color-bg-tertiary)] transition-colors disabled:opacity-50"
                                        >
                                            Revert to Shared Account
                                        </button>
                                    )}
                                </div>
                            </form>
                        </div>
                    )}
                </div>
            </main>
        </div>
    );
}
