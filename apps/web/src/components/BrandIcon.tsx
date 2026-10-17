export function BrandIcon({
	size = 28,
	className,
}: {
	size?: number;
	className?: string;
}) {
	return (
		<span className={className} style={{ display: "inline-flex", width: size, height: size }}>
			<img src="/pizza-icon.png" width={size} height={size} className="block dark:hidden" alt="Pizza" draggable={false} />
			<img src="/pizza-icon-dark.png" width={size} height={size} className="hidden dark:block" alt="Pizza" draggable={false} />
		</span>
	);
}
