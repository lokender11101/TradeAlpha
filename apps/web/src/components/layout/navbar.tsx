'use client';

import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import { Button } from '@/components/ui/button';
import { usePathname } from 'next/navigation';

export function Navbar() {
  const { user, logout } = useAuth();
  const pathname = usePathname();

  return (
    <nav className="border-b bg-background sticky top-0 z-50">
      <div className="container mx-auto px-4 h-16 flex items-center justify-between">
        <div className="flex items-center space-x-6">
          <Link href="/" className="font-bold text-xl tracking-tight text-primary">
            TradeAlpha
          </Link>
          
          {user && (
            <div className="hidden md:flex space-x-4">
              <Link 
                href="/dashboard" 
                className={`text-sm font-medium transition-colors hover:text-primary ${pathname === '/dashboard' ? 'text-foreground' : 'text-muted-foreground'}`}
              >
                Dashboard
              </Link>
              <Link 
                href="/terminal" 
                className={`text-sm font-medium transition-colors hover:text-primary ${pathname === '/terminal' ? 'text-foreground' : 'text-muted-foreground'}`}
              >
                Trading Terminal
              </Link>
            </div>
          )}
        </div>

        <div className="flex items-center space-x-4">
          {user ? (
            <>
              <span className="text-sm text-muted-foreground hidden md:inline-block">
                {user.email}
              </span>
              <Button variant="outline" size="sm" onClick={() => logout()}>
                Log out
              </Button>
            </>
          ) : (
            <>
              <Link href="/login">
                <Button variant="ghost" size="sm">Log in</Button>
              </Link>
              <Link href="/register">
                <Button size="sm">Sign up</Button>
              </Link>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}
