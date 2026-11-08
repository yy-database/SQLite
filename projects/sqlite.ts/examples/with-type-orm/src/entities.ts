import { EntitySchema } from "typeorm";

export type UserRow = {
  id: number;
  name: string;
  score: number | null;
};

export const UserEntity = new EntitySchema<UserRow>({
  name: "User",
  tableName: "users",
  columns: {
    id: {
      type: Number,
      primary: true,
      generated: true,
    },
    name: {
      type: String,
    },
    score: {
      type: "float",
      nullable: true,
    },
  },
});
