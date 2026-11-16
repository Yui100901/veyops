import React from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

function App() {
  return (
    <main>
      <h1>React 静态站点</h1>
      <p data-testid="delivery-marker">VeyOps React 发布成功</p>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
