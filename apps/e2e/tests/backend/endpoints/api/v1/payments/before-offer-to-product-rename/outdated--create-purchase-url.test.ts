import { generateUuid } from "@stackframe/stack-shared/dist/utils/uuids";
import { it } from "../../../../../../helpers";
import { Auth, Payments, Project, User, niceBackendFetch } from "../../../../../backend-helpers";

it("should not be able to create purchase URL without offer_id or offer_inline", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();
  const response = await niceBackendFetch("/api/v1/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: generateUuid(),
    },
  });
  expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 400,
        "body": "Must specify either product_id or product_inline!",
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
});

it("should error for non-existent offer_id", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      products: {
        "test-offer": {
          displayName: "Test Offer",
          customerType: "user",
          serverOnly: false,
          stackable: false,
          prices: {
            "monthly": {
              USD: "1000",
              interval: [1, "month"],
            },
          },
          includedItems: {},
        },
      },
    },
  });

  const response = await niceBackendFetch("/api/v1/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: generateUuid(),
      offer_id: "non-existent-offer",
    },
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "PRODUCT_DOES_NOT_EXIST",
        "details": {
          "context": null,
          "product_id": "non-existent-offer",
        },
        "error": "Product with ID \\"non-existent-offer\\" does not exist.",
      },
      "headers": Headers {
        "x-stack-known-error": "PRODUCT_DOES_NOT_EXIST",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("should error for invalid customer_id", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      products: {
        "test-offer": {
          displayName: "Test Offer",
          customerType: "user",
          serverOnly: false,
          stackable: false,
          prices: {
            "monthly": {
              USD: "1000",
              interval: [1, "month"],
            },
          },
          includedItems: {},
        },
      },
    },
  });

  await Auth.Otp.signIn();
  const response = await niceBackendFetch("/api/v1/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "team",
      customer_id: generateUuid(),
      offer_id: "test-offer",
    },
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "PRODUCT_CUSTOMER_TYPE_DOES_NOT_MATCH",
        "details": {
          "actual_customer_type": "team",
          "customer_id": "<stripped UUID>",
          "product_customer_type": "user",
          "product_id": "test-offer",
        },
        "error": "The team with ID \\"<stripped UUID>\\" is not a valid customer for the inline product that has been passed in. The product is configured to only be available for user customers, but the customer is a team.",
      },
      "headers": Headers {
        "x-stack-known-error": "PRODUCT_CUSTOMER_TYPE_DOES_NOT_MATCH",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("should error for no connected stripe account", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({
    payments: {
      products: {
        "test-offer": {
          displayName: "Test Offer",
          customerType: "user",
          serverOnly: false,
          stackable: false,
          prices: {
            "monthly": {
              USD: "1000",
              interval: [1, "month"],
            },
          },
          includedItems: {},
        },
      },
    },
  });

  const user = await User.create();
  const response = await niceBackendFetch("/api/v1/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: user.userId,
      product_id: "test-product",
    },
  });
  expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 400,
        "body": "Payments are not set up in this Stack Auth project. Please go to the Stack Auth dashboard and complete the Payments onboarding.",
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
});


it("should not allow offer_inline when calling from client", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Payments.setup();

  const { userId } = await Auth.Otp.signIn();
  const response = await niceBackendFetch("/api/v1/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: userId,
      offer_inline: {
        display_name: "Inline Test Offer",
        customer_type: "user",
        server_only: true,
        prices: {
          "monthly": {
            USD: "1000",
            interval: [1, "month"],
          },
        },
        included_items: {},
      },
    },
  });
  expect(response.body).toMatchInlineSnapshot(`"Cannot specify product_inline when calling from client! Please call with a server API key, or use the product_id parameter."`);
});

it("should error for server-only offer when calling from client", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      products: {
        "test-offer": {
          displayName: "Test Offer",
          customerType: "user",
          serverOnly: true,
          stackable: false,
          prices: {
            "monthly": {
              USD: "1000",
              interval: [1, "month"],
            },
          },
          includedItems: {},
        },
      },
    },
  });

  const { userId } = await User.create();
  const response = await niceBackendFetch("/api/v1/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: userId,
      offer_id: "test-offer",
    },
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "PRODUCT_DOES_NOT_EXIST",
        "details": {
          "context": "server_only",
          "product_id": "test-offer",
        },
        "error": "Product with ID \\"test-offer\\" is marked as server-only and cannot be accessed client side.",
      },
      "headers": Headers {
        "x-stack-known-error": "PRODUCT_DOES_NOT_EXIST",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("should allow offer_inline when calling from server", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Payments.setup();

  const { userId } = await Auth.Otp.signIn();
  const response = await niceBackendFetch("/api/v1/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "server",
    body: {
      customer_type: "user",
      customer_id: userId,
      offer_inline: {
        display_name: "Inline Test Offer",
        customer_type: "user",
        server_only: true,
        prices: {
          "monthly": {
            USD: "1000",
            interval: [1, "month"],
          },
        },
        included_items: {},
      },
    },
  });
  expect(response.status).toBe(200);
  expect(response.body.url).toMatch(/^https?:\/\/localhost:8101\/purchase\/[a-z0-9-_]+$/);
});

it("should allow valid offer_id", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      products: {
        "test-offer": {
          displayName: "Test Offer",
          customerType: "user",
          serverOnly: false,
          stackable: false,
          prices: {
            "monthly": {
              USD: "1000",
              interval: [1, "month"],
            },
          },
          includedItems: {},
        },
      },
    },
  });

  const { userId } = await User.create();
  const response = await niceBackendFetch("/api/v1/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: userId,
      offer_id: "test-offer",
    },
  });
  expect(response.status).toBe(200);
  const body = response.body as { url: string };
  expect(body.url).toMatch(/^https?:\/\/localhost:8101\/purchase\/[a-z0-9-_]+$/);
});
