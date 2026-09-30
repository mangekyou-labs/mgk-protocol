import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ChartToolbar } from './ChartToolbar';

describe('ChartToolbar', () => {
  const defaultProps = {
    resolution: '5m' as const,
    isConnected: true,
    onResolutionChange: () => {},
    onViewModeChange: () => {},
    viewMode: 'chart' as const,
  };

  // ── timeframe buttons ════════════════════════════════════════════

  it('renders all 6 timeframe buttons', () => {
    render(<ChartToolbar {...defaultProps} />);
    for (const tf of ['1m', '5m', '15m', '1h', '4h', '1d']) {
      expect(screen.getByTestId(`tf-${tf}`)).toBeDefined();
    }
  });

  it('marks the active resolution button', () => {
    render(<ChartToolbar {...defaultProps} resolution="1h" />);
    expect(screen.getByTestId('tf-1h').getAttribute('data-active')).toBe('true');
    expect(screen.getByTestId('tf-5m').getAttribute('data-active')).toBe('false');
  });

  // ── view mode buttons ════════════════════════════════════════════

  it('renders Chart | Market Info view mode buttons when onViewModeChange is provided', () => {
    render(<ChartToolbar {...defaultProps} />);
    expect(screen.getByTestId('vm-chart')).toBeDefined();
    expect(screen.getByTestId('vm-market-info')).toBeDefined();
  });

  it('does not render view mode buttons when onViewModeChange is omitted', () => {
    const { onViewModeChange: _, ...rest } = defaultProps;
    render(<ChartToolbar {...rest} />);
    expect(screen.queryByTestId('vm-chart')).toBeNull();
    expect(screen.queryByTestId('vm-market-info')).toBeNull();
  });

  // ── WS status badge ══════════════════════════════════════════════

  it('shows ● fills live in green when connected', () => {
    render(<ChartToolbar {...defaultProps} isConnected />);
    const el = screen.getByTestId('chart-ws-status');
    expect(el.textContent).toContain('fills live');
    // The dot is a child span
    const dot = el.querySelector('span');
    expect(dot?.className).toContain('text-online');
  });

  it('shows ○ fills off in warn/orange when disconnected', () => {
    render(<ChartToolbar {...defaultProps} isConnected={false} />);
    const el = screen.getByTestId('chart-ws-status');
    expect(el.textContent).toContain('fills off');
    const spans = el.querySelectorAll('span');
    expect(spans.length).toBeGreaterThanOrEqual(2);
    expect(spans[0]?.className).toContain('text-offline');
    expect(spans[1]?.className).toContain('text-warn');
  });

  it('shows fills delayed in warn when healthStatus is degraded', () => {
    render(<ChartToolbar {...defaultProps} isConnected healthStatus="degraded" />);
    const el = screen.getByTestId('chart-ws-status');
    expect(el.textContent).toContain('fills delayed');
    const spans = el.querySelectorAll('span');
    expect(spans[1]?.className).toContain('text-warn');
  });

  it('shows fills delayed when healthStatus is warming', () => {
    render(<ChartToolbar {...defaultProps} isConnected healthStatus="warming" />);
    const el = screen.getByTestId('chart-ws-status');
    expect(el.textContent).toContain('fills delayed');
  });

  it('shows fills off when healthStatus is critical even if isConnected', () => {
    render(<ChartToolbar {...defaultProps} isConnected healthStatus="critical" />);
    const el = screen.getByTestId('chart-ws-status');
    expect(el.textContent).toContain('fills off');
  });

  // ── disabled buttons ═════════════════════════════════════════════

  it('renders disabled Indicators button', () => {
    render(<ChartToolbar {...defaultProps} />);
    const btn = screen.getByTestId('btn-indicators');
    expect(btn).toBeDefined();
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders disabled Mark/Oracle toggle buttons', () => {
    render(<ChartToolbar {...defaultProps} />);
    const mark = screen.getByTestId('toggle-mark');
    const oracle = screen.getByTestId('toggle-oracle');
    expect(mark).toBeDefined();
    expect(oracle).toBeDefined();
    expect((mark as HTMLButtonElement).disabled).toBe(true);
    expect((oracle as HTMLButtonElement).disabled).toBe(true);
  });

  // ── data-testid root ═════════════════════════════════════════════

  it('renders with chart-toolbar data-testid', () => {
    render(<ChartToolbar {...defaultProps} />);
    expect(screen.getByTestId('chart-toolbar')).toBeDefined();
  });
});
