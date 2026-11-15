import { hydrateRoot } from 'react-dom/client';
import App from './App';
import './style.css';
const root = document.getElementById('root');
const app = <App lang={document.documentElement.lang === 'zh-CN' ? 'zh' : 'en'} />;
// The dev server has no pre-render step; production HTML is statically rendered.
if (import.meta.env.DEV) { const { createRoot } = await import('react-dom/client'); createRoot(root).render(app); }
else hydrateRoot(root, app);
