import { renderToString } from 'react-dom/server';
import App from './App';
export const render = lang => renderToString(<App lang={lang} />);
