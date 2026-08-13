'use client';

// Logout page: signs out via the SSR browser client and redirects to login.

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getBrowserClient } from '@/lib/supabase/browser';

export default function LogoutPage() {
  const router = useRouter();

  useEffect(() => {
    const signOut = async () => {
      const supabase = getBrowserClient();
      await supabase.auth.signOut();
      router.replace('/auth/login');
      router.refresh();
    };

    signOut();
  }, [router]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <p className="text-zinc-500">Signing out...</p>
    </div>
  );
}