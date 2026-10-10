"use client";

import { ExternalLink } from "lucide-react";
import { CopyButton } from "@/components/arc/copy-button/copy-button";
import {
  type DataColumn,
  SortableDataTable,
} from "@/components/arc/sortable-data-table/sortable-data-table";

/** One paid order, already formatted on the server. `amount` and `createdAt` are the sort keys. */
export type OrderRow = {
  orderId: string;
  productName: string;
  amount: number;
  amountLabel: string;
  payer: string;
  txHash: string;
  createdAt: number;
  time: string;
};

function shortHex(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

const columns: DataColumn<OrderRow>[] = [
  { key: "orderId", label: "Order" },
  { key: "productName", label: "Product", render: (_, row) => row.productName || "Not recorded" },
  {
    key: "amount",
    label: "Amount",
    numeric: true,
    render: (_, row) => <span className="nowrap">{row.amountLabel} pathUSD</span>,
  },
  {
    key: "payer",
    label: "Payer",
    render: (_, row) => (
      <span className="hex-cell">
        <span title={row.payer}>{shortHex(row.payer)}</span>
        <CopyButton value={row.payer} label="Copy payer address" iconOnly variant="plain" />
      </span>
    ),
  },
  {
    key: "createdAt",
    label: "Time (UTC)",
    numeric: false,
    render: (_, row) => <span className="nowrap">{row.time}</span>,
  },
  {
    key: "txHash",
    label: "Transaction",
    sortable: false,
    render: (_, row) => (
      <span className="hex-cell">
        <a
          className="tx-link"
          href={`https://explore.testnet.tempo.xyz/tx/${row.txHash}`}
          target="_blank"
          rel="noreferrer"
          aria-label={`View transaction ${shortHex(row.txHash)} on the Tempo explorer`}
        >
          {shortHex(row.txHash)}
          <ExternalLink size={16} strokeWidth={1.75} aria-hidden="true" />
        </a>
        <CopyButton value={row.txHash} label="Copy transaction hash" iconOnly variant="plain" />
      </span>
    ),
  },
];

export function OrdersTable({ rows }: { rows: OrderRow[] }) {
  return (
    <SortableDataTable
      rows={rows}
      columns={columns}
      rowKey="orderId"
      caption="Paid orders"
      defaultSort={{ key: "createdAt", direction: "desc" }}
    />
  );
}
