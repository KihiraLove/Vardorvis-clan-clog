/** Shared preview/public renderer: no raw HTML, embedded media or unsafe links. */
import Markdown, { defaultUrlTransform } from 'react-markdown';

export default function HelpMarkdown({ text }: { text: string }) {
  return (
    <div className="help-markdown">
      <Markdown
        skipHtml
        urlTransform={defaultUrlTransform}
        components={{
          a: ({ href, children }) =>
            href ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          img: ({ alt }) => <span>{alt}</span>,
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
