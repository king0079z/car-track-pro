import React from 'react';
export const LoadingSpinner: React.FC<{ size?: 'sm' | 'md' | 'lg'; className?: string }> = ({ 
  size = 'md', className = '' 
}) => {
  const sizes = { sm: 'w-4 h-4', md: 'w-8 h-8', lg: 'w-12 h-12' };
  return (
    <div className={`${sizes[size]} border-2 border-gray-700 border-t-brand-500 rounded-full animate-spin ${className}`} />
  );
};

export const PageLoader: React.FC = () => (
  <div className="flex items-center justify-center h-64">
    <div className="text-center space-y-4">
      <LoadingSpinner size="lg" className="mx-auto" />
      <p className="text-gray-500 text-sm">Loading...</p>
    </div>
  </div>
);
