# House photos

Drop a photo in this folder named after the house's address and it'll
automatically show up on the visitor sign-in "Welcome" screen for that
house. No code changes or database work needed.

Supported file types: .jpg, .jpeg, .png, .webp

## Naming rule

Take the address exactly as it's entered in the app, lowercase it, and
replace every run of spaces/punctuation with a single dash. Examples:

- "10909 Citreon Ct"      ->  10909-citreon-ct.jpg
- "428 Maple Street"      ->  428-maple-street.jpg
- "17 Birchwood Lane #2"  ->  17-birchwood-lane-2.jpg

If you're not sure you've got the naming exactly right, just try it --
worst case the photo doesn't show and the page looks the same as it does
now (no photo). Nothing breaks either way.

Upload photo files into this exact folder (public/house-photos/) via
GitHub the same way you upload everything else, and Render will pick it up
on the next deploy.
