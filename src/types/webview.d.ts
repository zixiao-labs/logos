import type { DetailedHTMLProps, HTMLAttributes } from "react";

// Electron's <webview> custom element is not part of React's JSX types.
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<
        HTMLAttributes<HTMLElement> & {
          src?: string;
          allowpopups?: string;
          partition?: string;
          preload?: string;
        },
        HTMLElement
      >;
    }
  }
}
