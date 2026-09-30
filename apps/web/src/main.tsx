import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { SyntheticBanner } from './components';
import { ChatPage } from './pages/ChatPage';
import { ResubmissionPage } from './pages/ResubmissionPage';
import { ReviewPage } from './pages/ReviewPage';
import { StatusPage } from './pages/StatusPage';

const routes = [
  { path: '/', label: 'Assessment chat', element: <ChatPage /> },
  { path: '/review', label: 'Human review', element: <ReviewPage /> },
  { path: '/status', label: 'Case status', element: <StatusPage /> },
  { path: '/resubmit', label: 'Resubmission', element: <ResubmissionPage /> },
] as const;

function App() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => { const onPop = () => setPath(window.location.pathname); window.addEventListener('popstate', onPop); return () => window.removeEventListener('popstate', onPop); }, []);
  const route = routes.find((entry) => entry.path === path) ?? routes[0];
  function go(target: string) { window.history.pushState({}, '', target); setPath(target); }
  return (
    <>
      <SyntheticBanner />
      <header className="site-header">
        <div><p className="eyebrow">B2B authorised representative POC</p><h1>Governed agentic assessment</h1></div>
        <nav aria-label="Primary">
          {routes.map((entry) => <a key={entry.path} href={entry.path} aria-current={entry.path === route.path ? 'page' : undefined} onClick={(event) => { event.preventDefault(); go(entry.path); }}>{entry.label}</a>)}
        </nav>
      </header>
      <main key={route.path}>{route.element}</main>
      <footer>All records and validations are synthetic. Communications are drafts. The deterministic governance engine — not the AI agent — issues every final outcome.</footer>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
