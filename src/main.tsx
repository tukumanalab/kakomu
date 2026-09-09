/* @refresh reload */
import { render } from 'solid-js/web';
import App from './app/App';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root が見つかりません');

render(() => <App />, root);
