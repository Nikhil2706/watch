import { redirect } from "next/navigation";

/** The tab most used first. */
export default function AdminHome() {
  redirect("/admin/library");
}
