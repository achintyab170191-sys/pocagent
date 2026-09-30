import { useEffect, useState } from 'react';
import { SyntheticBanner } from './components';
import { Icon } from './icons';
import { ChatPage } from './pages/ChatPage';
import { OperationsPage } from './pages/OperationsPage';
import { ReviewPage } from './pages/ReviewPage';
import { StatusPage } from './pages/StatusPage';

const routes = [
  { path: '/', label: 'Assessment chat', icon: 'chat', element: <ChatPage /> },
  { path: '/operations', label: 'Operations', icon: 'layers', element: <OperationsPage /> },
  { path: '/review', label: 'Review dashboard', icon: 'clipboard', element: <ReviewPage /> },
  { path: '/status', label: 'Case status', icon: 'search', element: <StatusPage /> },
] as const;

export function App() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => { const onPop = () => setPath(window.location.pathname); window.addEventListener('popstate', onPop); return () => window.removeEventListener('popstate', onPop); }, []);
  const route = routes.find((entry) => entry.path === path) ?? routes[0];
  function go(target: string) { window.history.pushState({}, '', target); setPath(target); window.scrollTo({ top: 0 }); }
  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <span className="brand-mark"><Icon name="spark" /></span>
            <div><p className="eyebrow">B2B customer operations</p><h1>SBO Assistant</h1></div>
          </div>
          <nav className="nav" aria-label="Primary">
            {routes.map((entry) => <a key={entry.path} href={entry.path} aria-current={entry.path === route.path ? 'page' : undefined} onClick={(event) => { event.preventDefault(); go(entry.path); }}><Icon name={entry.icon} />{entry.label}</a>)}
          </nav>
        </div>
      </header>
      <SyntheticBanner />
      <main key={route.path}>{route.element}</main>
      <footer>All records and validations are synthetic. Communications are drafts. The deterministic governance engine — not the AI agent — issues every final outcome, and no rejection is final until a human confirms it.</footer>
    </>
  );
}
