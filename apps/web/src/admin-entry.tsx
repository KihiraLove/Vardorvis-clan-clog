/** All staff screens form one on-demand entry; intra-admin navigation has no chunk waterfall. */
import { useEffect, useState, type ComponentProps } from 'react';
import { AdminPage } from './AdminPage.tsx';
import { XpPage } from './XpPage.tsx';
import { XpAdmin } from './XpAdmin.tsx';
import type { RouteResources } from './app-runtime.ts';

export function AdminEntry({
  takeEntry,
  ...props
}: Omit<ComponentProps<typeof AdminPage>, 'children' | 'initial'> & {
  takeEntry: RouteResources['takeEntry'];
}) {
  const [initial, setInitial] = useState(takeEntry);
  // Prepared private data is consumed once; logout/access loss can release every reference.
  useEffect(() => setInitial(undefined), []);
  return (
    <AdminPage {...props} initial={initial}>
      {(session, onAccessLost) =>
        props.path === '/admin/xp' ? (
          <XpPage
            client={props.xpClient}
            admin
            adminControls={(onApplied) => (
              <XpAdmin
                client={props.xpClient}
                competitionClient={props.competitionClient}
                session={session}
                onAccessLost={onAccessLost}
                onApplied={onApplied}
              />
            )}
          />
        ) : null
      }
    </AdminPage>
  );
}
