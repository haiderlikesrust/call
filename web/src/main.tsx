import { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'motion/react';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles.css';
import { App } from './App.tsx';

/**
 * If the page crashes (most likely an open tab from an older build meeting a newer server), reload once
 * to pick up the new build. If it crashes again within a minute, show a Reload button instead of a blank page.
 */
class Recover extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() {
    try {
      const last = Number(sessionStorage.getItem('holler-recovered') ?? 0);
      if (Date.now() - last > 60_000) {
        sessionStorage.setItem('holler-recovered', String(Date.now()));
        location.reload();
      }
    } catch { /* storage blocked: the button below still works */ }
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="crash">
        <p>This page hit a snag, most likely because the site just updated.</p>
        <button type="button" className="btn" onClick={() => location.reload()}>Reload</button>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <Recover>
    <MotionConfig reducedMotion="user">
      <App />
    </MotionConfig>
  </Recover>,
);
