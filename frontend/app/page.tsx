import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

export default function HomePage() {
    // Check for auth token cookie (adjust name if needed)
    const cookieStore = cookies();
    const token = cookieStore.get('token');
    if (token && token.value) {
        redirect('/portfolio');
    } else {
        redirect('/login');
    }
}
