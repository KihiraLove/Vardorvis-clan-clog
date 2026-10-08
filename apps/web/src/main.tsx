/** Mount the single React application into the root supplied by index.html. */
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './style.css';

createRoot(document.getElementById('root')!).render(<App />);
