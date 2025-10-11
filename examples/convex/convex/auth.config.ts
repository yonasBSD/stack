import { getConvexProvidersConfig } from "@stackframe/stack";

export default {
  providers: getConvexProvidersConfig({
    projectId: process.env.NEXT_PUBLIC_STACK_PROJECT_ID!,
    baseUrl: process.env.NEXT_PUBLIC_STACK_API_URL,
  }),
}
