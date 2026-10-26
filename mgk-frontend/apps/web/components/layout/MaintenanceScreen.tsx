import { Logo } from '@/components/common/Logo';

const DISABLED_ACTIONS = ['Place order', 'Cancel order', 'Deposit', 'Withdraw'];

export function MaintenanceScreen() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:px-8 sm:py-12">
      <header className="flex items-center gap-4">
        <Logo iconSize={40} />
        <span className="text-sm font-mono text-text-muted">Devnet demo</span>
      </header>

      <section
        role="status"
        aria-labelledby="maintenance-title"
        className="rounded-lg border border-warn bg-surface-1 p-6"
      >
        <p className="mb-3 text-sm font-medium text-warn">Maintenance</p>
        <h1 id="maintenance-title" className="text-2xl font-semibold text-text sm:text-3xl">
          The demo is being rebuilt.
        </h1>
        <p className="mt-4 text-base leading-relaxed text-text">
          Earlier devnet balances were not carried over.
        </p>
        <p id="maintenance-reason" className="mt-3 text-sm leading-relaxed text-text-muted">
          Trading and account actions are disabled while we rebuild the demo.
          Please return after the rebuilt demo is released.
        </p>
      </section>

      <section aria-label="Unavailable actions" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {DISABLED_ACTIONS.map((action) => (
          <button
            key={action}
            type="button"
            disabled
            aria-describedby="maintenance-reason"
            className="min-h-11 cursor-not-allowed rounded-md border border-border-strong bg-surface-2 px-4 py-3 text-sm text-text-muted"
          >
            {action}
          </button>
        ))}
      </section>
    </main>
  );
}
