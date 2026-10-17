export function BrandIcon({
	size = 28,
	className,
}: {
	size?: number;
	className?: string;
}) {
	return (
		<img
			src="/pizza-icon.png"
			width={size}
			height={size}
			className={className}
			alt="Pizza"
			draggable={false}
		/>
	);
}
