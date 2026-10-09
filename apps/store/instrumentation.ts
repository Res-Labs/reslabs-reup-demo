export async function register(): Promise<void> {
  // Next.js also compiles this file for the edge runtime, which cannot load better-sqlite3,
  // so the reconciler is imported only inside the Node.js branch.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startReconciler } = await import("./lib/reorder");
    startReconciler();
  }
}
