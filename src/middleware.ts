import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isPublicRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/transcode-video",
  "/api/analyze",
]);

export default clerkMiddleware(
  async (auth, req) => {
    if (!isPublicRoute(req)) {
      // Without an explicit sign-in URL, auth.protect() answers signed-out page
      // requests with a 404. Send visitors to the sign-in page instead.
      await auth.protect({ unauthenticatedUrl: new URL("/sign-in", req.url).toString() });
    }
  },
  { signInUrl: "/sign-in", signUpUrl: "/sign-up" },
);

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest|wav|mp3|m4a|aac|ogg|flac|mp4|m4v|mov|webm)).*)",
    "/(api|trpc)(.*)",
  ],
};
