export interface User {
  name: string;
}

/** The name of a user, or an empty string when there is no user. */
export function getName(user: User | null): string {
  const name = user.name;
  return name;
}
