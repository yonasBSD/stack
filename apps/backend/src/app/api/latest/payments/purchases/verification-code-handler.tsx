import { createVerificationCodeHandler } from "@/route-handlers/verification-code-handler";
import { VerificationCodeType } from "@prisma/client";
import { productSchema, yupObject, yupString } from "@stackframe/stack-shared/dist/schema-fields";

export const purchaseUrlVerificationCodeHandler = createVerificationCodeHandler({
  type: VerificationCodeType.PURCHASE_URL,
  method: yupObject({}),
  data: yupObject({
    tenancyId: yupString().defined(),
    customerId: yupString().defined(),
    productId: yupString(),
    product: productSchema,
    stripeCustomerId: yupString().defined(),
    stripeAccountId: yupString().defined(),
  }),
  // @ts-ignore TODO: fix this
  async handler(_, __, data) {
    return null;
  },
});
