import { MontajWeekOne } from "@/components/montaj-week-one";

export default async function ProjectEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <MontajWeekOne projectId={id} />;
}
