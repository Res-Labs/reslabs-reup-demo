import { listOrders } from "../../lib/ledger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatTime(unixSeconds: number): string {
  return `${new Date(unixSeconds * 1000).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

export default function OrdersPage() {
  const orders = listOrders();

  return (
    <section>
      <h1 className="page-title">Orders</h1>
      {orders.length === 0 ? (
        <p className="empty">No orders yet.</p>
      ) : (
        <table className="orders">
          <thead>
            <tr>
              <th>Order</th>
              <th>Product</th>
              <th>Amount</th>
              <th>Payer</th>
              <th>Time</th>
              <th>Transaction</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr key={order.orderId}>
                <td data-label="Order" className="mono">
                  {order.orderId}
                </td>
                <td data-label="Product">{order.productName}</td>
                <td data-label="Amount">{order.amount} pathUSD</td>
                <td data-label="Payer" className="mono" title={order.payer}>
                  {shortAddress(order.payer)}
                </td>
                <td data-label="Time">{formatTime(order.createdAt)}</td>
                <td data-label="Transaction">
                  <a
                    href={`https://explore.testnet.tempo.xyz/tx/${order.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View on explorer
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
