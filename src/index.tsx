import { registerDetailsViewSection } from '@kinvolk/headlamp-plugin/lib';
import { FilesSection } from './FilesSection';

// Adds a "Files" section to every Pod details page.
registerDetailsViewSection(({ resource }) => {
  if (resource?.kind !== 'Pod') return null;
  return <FilesSection pod={resource as any} />;
});
