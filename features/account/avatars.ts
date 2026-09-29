export const AVATARS = [
  { id: "cat", label: "Cat", src: "/avatars/cat.png" },
  { id: "dog", label: "Dog", src: "/avatars/dog.png" },
  { id: "gamer", label: "Gamer", src: "/avatars/gamer.png" },
  { id: "girl", label: "Girl", src: "/avatars/girl.png" },
  { id: "man", label: "Man", src: "/avatars/man.png" },
  { id: "panda", label: "Panda", src: "/avatars/panda.png" },
  { id: "rabbit", label: "Rabbit", src: "/avatars/rabbit.png" },
  { id: "woman", label: "Woman", src: "/avatars/woman.png" },
] as const;

export type AvatarId = (typeof AVATARS)[number]["id"];

export function isAvatarId(value: unknown): value is AvatarId {
  return (
    typeof value === "string" && AVATARS.some((avatar) => avatar.id === value)
  );
}

export function avatarDefinition(avatarId: string) {
  return AVATARS.find((avatar) => avatar.id === avatarId);
}
