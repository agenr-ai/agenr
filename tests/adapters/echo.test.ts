import { describe, expect, test } from "vitest";

import EchoAdapter from "../../data/adapters/echo";
import { createMockContext } from "../helpers/mock-context";

function createAdapter(): EchoAdapter {
  return new EchoAdapter(
    {
      id: "echo",
      name: "Echo Labs",
      platform: "echo",
    },
    createMockContext({ platform: "echo" }),
  );
}

describe("echo adapter", () => {
  test("echo discover returns services", async () => {
    const adapter = createAdapter();

    const result = (await adapter.discover()) as {
      business: { name: string; description: string };
      services: Array<{ id: string }>;
      hints: {
        typicalFlow: string;
        queryParams: { catalog: { serviceId: string } };
        executeParams: { order: { serviceId: string; items: Array<Record<string, unknown>> } };
        confirmationFlow: string;
        simulationModes: { failure: string; expired: string };
      };
    };

    expect(result.business.name).toBe("Echo Labs");
    expect(typeof result.business.description).toBe("string");
    expect(result.business.description.trim().length > 0).toBe(true);
    expect(result.services).toHaveLength(3);
    expect(result.services.map((service) => service.id)).toEqual(["catalog", "order", "ping"]);
    expect(result.hints).toHaveProperty("typicalFlow");
    expect(result.hints).toHaveProperty("queryParams");
    expect(result.hints).toHaveProperty("executeParams");
    expect(result.hints).toHaveProperty("confirmationFlow");
    expect(result.hints).toHaveProperty("simulationModes");
    expect(typeof result.hints.typicalFlow).toBe("string");
    expect(result.hints.typicalFlow.trim().length > 0).toBe(true);
    expect(result.hints.queryParams.catalog.serviceId).toBe("catalog");
    expect(result.hints.executeParams.order.serviceId).toBe("order");
    expect(Array.isArray(result.hints.executeParams.order.items)).toBe(true);
    expect(result.hints.confirmationFlow).toContain("confirmationToken");
    expect(result.hints.simulationModes).toHaveProperty("failure");
    expect(result.hints.simulationModes).toHaveProperty("expired");
  });

  test("echo query catalog returns products", async () => {
    const adapter = createAdapter();

    const result = (await adapter.query({ serviceId: "catalog" })) as {
      results: Array<Record<string, unknown>>;
    };
    expect(result.results).toHaveLength(3);
    expect(result.results[0]).toEqual({
      id: "echo-widget-1",
      name: "Widget",
      price: 9.99,
      currency: "USD",
    });
    expect(result.results[2]).toEqual({
      id: "echo-sub-1",
      name: "Pro Plan",
      price: 49.99,
      currency: "USD",
      interval: "month",
    });
  });

  test("echo query ping echoes input", async () => {
    const adapter = createAdapter();

    const result = (await adapter.query({
      serviceId: "ping",
      options: { hello: "world" },
    })) as { echo: Record<string, unknown> };

    expect(result).toEqual({
      echo: { hello: "world" },
    });
  });

  test("echo execute without confirmationToken returns pending_confirmation", async () => {
    const adapter = createAdapter();

    const result = (await adapter.execute(
      { items: [{ productId: "echo-widget-1", quantity: 2 }] },
      {},
    )) as {
      status: string;
      confirmationToken: string;
      summary: {
        items: Array<Record<string, unknown>>;
        subtotal: number;
        tax: number;
        total: number;
      };
    };

    expect(result.status).toBe("pending_confirmation");
    expect(result.confirmationToken.startsWith("echo-confirm-")).toBe(true);
    expect(result.summary.items).toEqual([
      { productId: "echo-widget-1", name: "Widget", quantity: 2, price: 9.99 },
    ]);
    expect(result.summary.subtotal).toBe(19.98);
    expect(result.summary.tax).toBe(1.65);
    expect(result.summary.total).toBe(21.63);
  });

  test("echo execute with valid confirmationToken returns completed", async () => {
    const adapter = createAdapter();

    const result = (await adapter.execute(
      {
        confirmationToken: "echo-confirm-12345",
        items: [{ productId: "echo-widget-2", quantity: 1 }],
      },
      {},
    )) as {
      status: string;
      orderId: string;
      receipt: { total: number; paidAt: string };
    };

    expect(result.status).toBe("completed");
    expect(result.orderId.startsWith("echo-order-")).toBe(true);
    expect(result.receipt.total).toBe(27.05);
    expect(Number.isNaN(Date.parse(result.receipt.paidAt))).toBe(false);
  });

  test("echo execute with invalid confirmationToken returns failed", async () => {
    const adapter = createAdapter();

    const result = (await adapter.execute(
      { confirmationToken: "bad-token" },
      {},
    )) as { status: string; error: string };

    expect(result).toEqual({
      status: "failed",
      error: "Invalid confirmation token",
    });
  });

  test("echo execute simulates failure", async () => {
    const adapter = createAdapter();

    const result = (await adapter.execute({ simulate: "failure" }, {})) as {
      status: string;
      error: string;
    };

    expect(result).toEqual({
      status: "failed",
      error: "Simulated failure for testing",
    });
  });

  test("echo execute simulates expired token", async () => {
    const adapter = createAdapter();

    const result = (await adapter.execute({ simulate: "expired" }, {})) as {
      status: string;
      error: string;
    };

    expect(result).toEqual({
      status: "failed",
      error: "Confirmation token expired. Please start a new order.",
    });
  });

  test("echo query unknown service returns empty", async () => {
    const adapter = createAdapter();

    const result = (await adapter.query({ serviceId: "nonexistent" })) as {
      results: unknown[];
    };
    expect(result).toEqual({ results: [] });
  });

  test("echo execute confirmation includes tax calculation", async () => {
    const adapter = createAdapter();

    const result = (await adapter.execute(
      { items: [{ productId: "echo-widget-2", quantity: 1 }] },
      {},
    )) as {
      status: string;
      summary: { subtotal: number; tax: number; total: number };
    };

    expect(result.status).toBe("pending_confirmation");
    expect(result.summary.subtotal).toBe(24.99);
    expect(result.summary.tax).toBe(2.06);
    expect(result.summary.total).toBe(27.05);
  });
});
