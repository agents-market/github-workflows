import { getId } from "../node_modules/@aws-sdk/identity/index.js";

export async function computeCognitoIdentity(wallet) {
  const region = "eu-central-1";
  const poolId = "eu-central-1:8975";
  if (!wallet) {
    const id = await getId();
    return { wallet, region, poolId, id };
  }
  return { wallet, region, poolId };
}
