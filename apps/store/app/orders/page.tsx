import { Receipt } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import { type OrderRow, OrdersTable } from "@/components/orders-table";
import { listOrders } from "../../lib/ledger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const timeFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export default async function OrdersPage() {
  const rows: OrderRow[] = (await listOrders()).map((order) => ({
    orderId: order.orderId,
    productName: order.productName,
    amount: Number(order.amount),
    amountLabel: order.amount,
    payer: order.payer,
    txHash: order.txHash,
    createdAt: order.createdAt,
    time: timeFormat.format(new Date(order.createdAt * 1000)),
  }));

  return (
    <>
      <div className="page-head">
        <h1>Paid orders</h1>
        <p className="lede">Reorders that agents paid for on Tempo testnet, newest first.</p>
      </div>
      {rows.length === 0 ? (
        <div className="empty-panel">
          <EmptyState
            label="Paid orders"
            icon={<Receipt size={24} strokeWidth={1.75} />}
            title="No orders yet"
            description="An order appears here after an agent pays for a reorder."
            action={
              <Link className="primary-link" href="/">
                View the product
              </Link>
            }
          />
        </div>
      ) : (
        <OrdersTable rows={rows} />
      )}
    </>
  );
}
