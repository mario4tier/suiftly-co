/**
 * Logs Page - User Activity Logs
 */

import { createLazyFileRoute } from '@tanstack/react-router';
import { DashboardLayout } from '../components/layout/DashboardLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { trpc } from '@/lib/trpc';
import { useState } from 'react';
import { Loader2, ChevronLeft, ChevronRight } from 'lucide-react';

export const Route = createLazyFileRoute('/logs')({
  component: LogsPage,
});

const PAGE_SIZE = 20;

function LogsPage() {
  const [offset, setOffset] = useState(0);
  const { data, isLoading, error } = trpc.activity.getLogs.useQuery({
    offset,
    limit: PAGE_SIZE,
  });

  const handleLoadMore = () => {
    setOffset(prev => prev + PAGE_SIZE);
  };

  const handleBackToTop = () => {
    setOffset(0);
  };

  const isAtTop = offset === 0;
  const hasMore = data?.hasMore ?? false;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Activity Logs</h2>
          <p className="text-muted-foreground mt-2">
            Recent user actions (up to 100 entries)
          </p>
        </div>

        <Card>
          <CardContent className="pt-6">
            {isLoading && (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            )}

            {error && (
              <div className="text-center py-12">
                <p className="text-destructive">Failed to load activity logs</p>
                <p className="text-sm text-muted-foreground mt-2">{error.message}</p>
              </div>
            )}

            {!isLoading && !error && data && (
              <>
                {data.logs.length === 0 && offset === 0 ? (
                  <div className="text-center py-12">
                    <div className="text-6xl mb-4">📝</div>
                    <h3 className="text-xl font-semibold mb-2">No Activity Yet</h3>
                    <p className="text-muted-foreground">
                      Activity logs will appear after you log in or configure services
                    </p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {/* Log entries - compact, no borders, easy to copy */}
                    <div className="space-y-0.5 font-mono text-sm">
                      {data.logs.map((log, index) => {
                        const timestamp = new Date(log.timestamp);
                        const formattedDate = timestamp.toLocaleString('en-US', {
                          month: '2-digit',
                          day: '2-digit',
                          year: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                          hour12: false,
                        });

                        return (
                          <div
                            key={`${log.timestamp}-${index}`}
                            className="py-0.5 hover:bg-accent/30 transition-colors"
                          >
                            <span className="text-muted-foreground">{formattedDate}</span>
                            <span className="mx-2 text-muted-foreground">{log.clientIp}</span>
                            <span>{log.message}</span>
                          </div>
                        );
                      })}
                    </div>

                    {/* Pagination controls */}
                    <div className="flex items-center justify-between pt-4 border-t">
                      <div className="text-sm text-muted-foreground">
                        Showing {offset + 1} - {offset + data.logs.length} of {data.totalCount}
                      </div>

                      <div className="flex gap-2">
                        {!isAtTop && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={handleBackToTop}
                          >
                            <ChevronLeft className="h-4 w-4 mr-1" />
                            Back to Top
                          </Button>
                        )}

                        {hasMore && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={handleLoadMore}
                          >
                            Load More
                            <ChevronRight className="h-4 w-4 ml-1" />
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
