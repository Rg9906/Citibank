// One panel failing (bad message, browser quirk) must not blank the whole console during a demo.
import { Component, type ReactNode } from "react";

export class Boundary extends Component<{ name: string; children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) { return { error: e instanceof Error ? e.message : String(e) }; }
  componentDidCatch(e: unknown) { console.error(`panel ${this.props.name} failed`, e); }
  render() {
    if (this.state.error) {
      return (
        <section className="panel">
          <h3>{this.props.name} <span className="badge offline">panel error</span></h3>
          <p className="muted small">{this.state.error}</p>
          <button onClick={() => this.setState({ error: null })}>retry</button>
        </section>
      );
    }
    return this.props.children;
  }
}
