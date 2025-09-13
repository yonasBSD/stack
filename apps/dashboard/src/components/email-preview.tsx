import { useAdminApp } from "@/app/(main)/(protected)/projects/[projectId]/use-admin-app";
import { KnownErrors } from "@stackframe/stack-shared";
import { Spinner, Typography } from "@stackframe/stack-ui";
import { Component, Fragment, ReactNode, Suspense } from "react";
import { useDebounce } from 'use-debounce';
import ResizableContainer from './resizable-container';

class EmailPreviewErrorBoundary extends Component<
  { children: ReactNode },
  { error: KnownErrors["EmailRenderingError"] | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    if (error instanceof KnownErrors.EmailRenderingError) {
      return { error: error as KnownErrors["EmailRenderingError"] };
    }
    throw error;
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center p-4 h-full justify-center">
          <Typography type="h3" className="mb-2" variant="destructive">
            Email Rendering Error
          </Typography>
          <Typography variant="secondary" className="whitespace-pre-wrap">
            {this.state.error.message}
          </Typography>
        </div>
      );
    }
    return this.props.children;
  }
}

function EmailPreviewContent({
  themeId,
  themeTsxSource,
  templateId,
  templateTsxSource,
}: {
  themeId?: string | undefined | false,
  themeTsxSource?: string,
  templateId?: string,
  templateTsxSource?: string,
}) {
  const stackAdminApp = useAdminApp();

  const previewHtml = stackAdminApp.useEmailPreview({
    themeId,
    themeTsxSource,
    templateId,
    templateTsxSource
  });

  return (
    <iframe
      srcDoc={previewHtml}
      className="w-full h-full border-0"
      title="Email Preview"
    />
  );
}

type EmailPreviewProps =
  | ({
    themeId: string | undefined | false,
    themeTsxSource?: undefined,
  } | {
    themeId?: undefined,
    themeTsxSource: string,
  })
  & (
    | {
      templateId: string,
      templateTsxSource?: undefined,
    }
    | {
      templateId?: undefined,
      templateTsxSource: string,
    }
  ) & {
    disableResizing?: boolean,
  };

export default function EmailPreview({
  themeId,
  themeTsxSource,
  templateId,
  templateTsxSource,
  disableResizing,
}: EmailPreviewProps) {
  const [debouncedTemplateTsxSource] = useDebounce(templateTsxSource, 500);
  const [debouncedThemeTsxSource] = useDebounce(themeTsxSource, 500);
  const Container = disableResizing ? Fragment : ResizableContainer;

  return (
    <div className={`w-full h-full flex flex-col justify-center ${disableResizing ? "pointer-events-none" : ""}`}>
      <Container>
        <Suspense fallback={
          <div className="flex items-center justify-center h-full">
            <Spinner />
          </div>
        }>
          <EmailPreviewErrorBoundary key={`${debouncedTemplateTsxSource ?? ""}${debouncedThemeTsxSource ?? ""}`}>
            <EmailPreviewContent
              themeId={themeId}
              themeTsxSource={debouncedThemeTsxSource}
              templateId={templateId}
              templateTsxSource={debouncedTemplateTsxSource}
            />
          </EmailPreviewErrorBoundary>
        </Suspense>
      </Container>
    </div>
  );
}
