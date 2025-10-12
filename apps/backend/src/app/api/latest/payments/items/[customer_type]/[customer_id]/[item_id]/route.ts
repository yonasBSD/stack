import { ensureCustomerExists, getItemQuantityForCustomer } from "@/lib/payments";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@stackframe/stack-shared";
import { adaptSchema, clientOrHigherAuthTypeSchema, yupNumber, yupObject, yupString } from "@stackframe/stack-shared/dist/schema-fields";
import { getOrUndefined } from "@stackframe/stack-shared/dist/utils/objects";


export const GET = createSmartRouteHandler({
  metadata: {
    hidden: false,
    summary: "Get Item",
    description: "Retrieves information about a specific item (credits, quotas, etc.) for a customer.",
    tags: ["Payments"],
  },
  request: yupObject({
    auth: yupObject({
      type: clientOrHigherAuthTypeSchema.defined(),
      project: adaptSchema.defined(),
      tenancy: adaptSchema.defined(),
    }).defined(),
    params: yupObject({
      customer_type: yupString().oneOf(["user", "team", "custom"]).defined().meta({
        openapiField: {
          description: "The type of customer",
          exampleValue: "user"
        }
      }),
      customer_id: yupString().defined().meta({
        openapiField: {
          description: "The ID of the customer",
          exampleValue: "user_1234567890abcdef"
        }
      }),
      item_id: yupString().defined().meta({
        openapiField: {
          description: "The ID of the item to retrieve",
          exampleValue: "credits"
        }
      }),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      id: yupString().defined().meta({
        openapiField: {
          description: "The ID of the item",
          exampleValue: "credits"
        }
      }),
      display_name: yupString().defined().meta({
        openapiField: {
          description: "The human-readable name of the item",
          exampleValue: "API Credits"
        }
      }),
      quantity: yupNumber().defined().meta({
        openapiField: {
          description: "The current quantity of the item (can be negative)",
          exampleValue: 1000
        }
      }),
    }).defined(),
  }),
  handler: async (req) => {
    const { tenancy } = req.auth;
    const paymentsConfig = tenancy.config.payments;

    const itemConfig = getOrUndefined(paymentsConfig.items, req.params.item_id);
    if (!itemConfig) {
      throw new KnownErrors.ItemNotFound(req.params.item_id);
    }
    if (req.params.customer_type !== itemConfig.customerType) {
      throw new KnownErrors.ItemCustomerTypeDoesNotMatch(req.params.item_id, req.params.customer_id, itemConfig.customerType, req.params.customer_type);
    }
    const prisma = await getPrismaClientForTenancy(tenancy);
    await ensureCustomerExists({
      prisma,
      tenancyId: tenancy.id,
      customerType: req.params.customer_type,
      customerId: req.params.customer_id,
    });
    const totalQuantity = await getItemQuantityForCustomer({
      prisma,
      tenancy,
      itemId: req.params.item_id,
      customerId: req.params.customer_id,
      customerType: req.params.customer_type,
    });
    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        id: req.params.item_id,
        display_name: itemConfig.displayName,
        quantity: totalQuantity,
      },
    };
  },
});


