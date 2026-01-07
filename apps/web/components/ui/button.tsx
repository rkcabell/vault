import * as React from "react"

export interface ButtonProps
    extends React.ButtonHTMLAttributes<HTMLButtonElement> { }

function cn(...classes: Array<string | undefined | false | null>) {
    return classes.filter(Boolean).join(" ")
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
    ({ className, ...props }, ref) => (
        <button
            ref={ref}
            className={cn(
                "button button--default",
                className
            )}
            {...props}
        />
    )

)

Button.displayName = "Button"
