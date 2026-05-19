import type { SupabaseClient } from "@supabase/supabase-js";
import type { TimelineMedia } from "@/lib/media";
import type { Overlay } from "@/lib/overlays";
import type { TransitionStyle } from "@/components/slideshow-composition";

export type ProjectDocument = {
  timeline: TimelineMedia[];
  selectedTrackId: string;
  targetSeconds: number;
  overlays?: Overlay[];
  transitionStyle?: TransitionStyle;
};

type ProjectRow = {
  id: string;
  user_id: string;
  name: string;
  document: ProjectDocument | null;
  document_updated_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ProjectSummary = Pick<
  ProjectRow,
  "id" | "name" | "created_at" | "updated_at"
>;

export async function listProjects(
  supabase: SupabaseClient,
): Promise<ProjectSummary[]> {
  const { data, error } = await supabase
    .from("projects")
    .select("id, name, created_at, updated_at")
    .order("updated_at", { ascending: false });
  if (error) throw new Error(`listProjects: ${error.message}`);
  return data ?? [];
}

export async function createProject(
  supabase: SupabaseClient,
  userId: string,
  name = "Untitled project",
): Promise<ProjectRow> {
  const { data, error } = await supabase
    .from("projects")
    .insert({ user_id: userId, name })
    .select()
    .single();
  if (error) throw new Error(`createProject: ${error.message}`);
  return data as ProjectRow;
}

export async function getProject(
  supabase: SupabaseClient,
  id: string,
): Promise<ProjectRow | null> {
  const { data, error } = await supabase
    .from("projects")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`getProject: ${error.message}`);
  return (data as ProjectRow | null) ?? null;
}

export async function updateProjectDocument(
  supabase: SupabaseClient,
  id: string,
  document: ProjectDocument,
): Promise<void> {
  const { error } = await supabase
    .from("projects")
    .update({
      document,
      document_updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw new Error(`updateProjectDocument: ${error.message}`);
}

export async function renameProject(
  supabase: SupabaseClient,
  id: string,
  name: string,
): Promise<void> {
  const { error } = await supabase.from("projects").update({ name }).eq("id", id);
  if (error) throw new Error(`renameProject: ${error.message}`);
}

export async function deleteProject(
  supabase: SupabaseClient,
  id: string,
): Promise<void> {
  const { error } = await supabase.from("projects").delete().eq("id", id);
  if (error) throw new Error(`deleteProject: ${error.message}`);
}
